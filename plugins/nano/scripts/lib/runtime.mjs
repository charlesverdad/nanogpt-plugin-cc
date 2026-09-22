// Runtime contract for running Claude Code headless against NanoGPT.
//
// The companion does not talk to NanoGPT directly for tasks and reviews: it
// spawns `claude -p` with ANTHROPIC_BASE_URL pointed at NanoGPT's
// Anthropic-compatible endpoint, and restricts what the child may do with
// `--restricted`, `--tools`, `--allowedTools` and `--permission-mode dontAsk`.
// See .claude/LEARNINGS.md for the verified runtime facts behind each flag.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, runCommand } from "./process.mjs";
import { ensurePrivateDir, resolveFallbackDataDir } from "./state.mjs";

export const DEFAULT_BASE_URL = "https://nano-gpt.com/api";
export const KEYCHAIN_SERVICE = "nanogpt-api-key";
export const KEY_SETUP_COMMAND = 'security add-generic-password -a "$USER" -s nanogpt-api-key -w';
export const MIN_CLAUDE_VERSION = "2.1.278";
export const API_TIMEOUT_MS = "600000";

// Default turn caps. NanoGPT's weekly quota counts every input token,
// including prompt-cache reads, and each turn resends the whole conversation,
// so unbounded multi-turn runs burn quota fast.
export const DEFAULT_TASK_MAX_TURNS = 25;
export const DEFAULT_REVIEW_MAX_TURNS = 15;
export const MAX_TURNS_LIMIT = 500;

// Host settings that would route the child to a different provider or a paid
// Claude model. They are removed before ours are applied.
export const STRIPPED_ENV_VARS = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SUBAGENT_MODEL"
]);

export const READ_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
// Only commands none of whose options can write a file or run repo code: an
// allowlisted prefix runs with any arguments.
// `git diff`/`git log`/`git show` are deliberately absent: their `--output=<file>`
// option writes anywhere (including `.git/config`), which Claude Code's Bash
// path checks do not catch.
export const DEFAULT_BASH_ALLOW = Object.freeze(["git status", "ls"]);
export const PROFILES = Object.freeze(["read", "write"]);
export const OUTPUT_FORMATS = Object.freeze(["json", "stream-json"]);

export function getClaudeAvailability(cwd) {
  return binaryAvailable("claude", ["--version"], { cwd });
}

export function parseClaudeVersion(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function readSecretCommand(runCommandImpl, command, args) {
  try {
    const result = runCommandImpl(command, args, { env: process.env });
    if (result.error || result.status !== 0) {
      return null;
    }
    const value = String(result.stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the NanoGPT API key. The key itself must never be written to job
 * files, logs or rendered output; callers only ever report `source`.
 *
 * @returns {{ key: string | null, source: string | null }}
 */
export function resolveApiKey(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;

  const fromEnv = String(env.NANOGPT_API_KEY ?? "").trim();
  if (fromEnv) {
    return { key: fromEnv, source: "NANOGPT_API_KEY environment variable" };
  }

  if (platform === "darwin") {
    const key = readSecretCommand(runCommandImpl, "security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (key) {
      return { key, source: `macOS keychain (service ${KEYCHAIN_SERVICE})` };
    }
  } else if (platform === "linux") {
    const key = readSecretCommand(runCommandImpl, "secret-tool", ["lookup", "service", KEYCHAIN_SERVICE]);
    if (key) {
      return { key, source: `secret-tool (service ${KEYCHAIN_SERVICE})` };
    }
  }

  return { key: null, source: null };
}

export function requireApiKey(options = {}) {
  const resolved = resolveApiKey(options);
  if (!resolved.key) {
    throw new Error(
      `No NanoGPT API key found. Store it in the macOS keychain with:\n  ${KEY_SETUP_COMMAND}\n` +
        "(or export NANOGPT_API_KEY), then rerun `/nano:setup`."
    );
  }
  return resolved;
}

export function resolveBaseUrl(env = process.env) {
  const value = String(env.NANOGPT_BASE_URL ?? "").trim() || DEFAULT_BASE_URL;
  return value.replace(/\/+$/, "");
}

/**
 * Build the child environment for a `claude` run on NanoGPT. Every model slot
 * is pinned to `model` so no background call can reach a paid Claude model.
 */
export function buildChildEnv({ baseEnv = process.env, apiKey, model, baseUrl } = {}) {
  if (!apiKey) {
    throw new Error("buildChildEnv requires an API key.");
  }
  if (!model) {
    throw new Error("buildChildEnv requires a model.");
  }
  const env = { ...baseEnv };
  for (const name of STRIPPED_ENV_VARS) {
    delete env[name];
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl ?? resolveBaseUrl(baseEnv),
    ANTHROPIC_API_KEY: apiKey,
    API_TIMEOUT_MS,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model
  };
}

/**
 * Validate and de-duplicate Bash allowlist prefixes. Characters that would
 * break out of a `Bash(<prefix>:*)` rule or the comma-separated
 * `--allowedTools` value are rejected rather than escaped.
 */
export function normalizeBashAllow(prefixes = []) {
  const seen = new Set();
  const result = [];
  for (const raw of prefixes) {
    const trimmed = String(raw ?? "").trim();
    if (/[(),\n\r*]/.test(trimmed)) {
      throw new Error(`Invalid Bash allowlist prefix "${JSON.stringify(trimmed).slice(1, -1)}": it must not contain parentheses, commas, "*" or newlines.`);
    }
    const prefix = trimmed.replace(/\s+/g, " ");
    if (!prefix) {
      continue;
    }
    if (!seen.has(prefix)) {
      seen.add(prefix);
      result.push(prefix);
    }
  }
  return result;
}

/**
 * Pure permission profile builder.
 *
 * - read:  Read/Glob/Grep only. No Bash, Edit or Write exists in the child.
 * - write: file edits confined to the working directory plus prefix-matched
 *          Bash commands from the allowlist. Bash is dropped from the toolset
 *          entirely when the allowlist is empty.
 */
export function buildPermissionProfile(profile, options = {}) {
  if (profile === "read") {
    return { name: "read", tools: [...READ_TOOLS], allowedTools: [...READ_TOOLS], bashAllow: [] };
  }
  if (profile === "write") {
    const bashAllow = normalizeBashAllow(options.bashAllow ?? DEFAULT_BASH_ALLOW);
    return {
      name: "write",
      tools: [...READ_TOOLS, "Edit", "Write", ...(bashAllow.length > 0 ? ["Bash"] : [])],
      allowedTools: [...READ_TOOLS, "Edit(./**)", "Write(./**)", ...bashAllow.map((prefix) => `Bash(${prefix}:*)`)],
      bashAllow
    };
  }
  throw new Error(`Unknown permission profile "${profile}". Expected one of: ${PROFILES.join(", ")}.`);
}

/**
 * Normalize a `--max-turns` value (from the CLI it arrives as a string) to an
 * integer between 1 and MAX_TURNS_LIMIT. Returns null for null/undefined and
 * throws a clear error for anything else.
 */
export function normalizeMaxTurns(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_TURNS_LIMIT) {
    throw new Error(`Invalid --max-turns "${value}": expected an integer between 1 and ${MAX_TURNS_LIMIT}.`);
  }
  return n;
}

// True when a claude result stopped because it hit the --max-turns cap
// (subtype "error_max_turns" / terminal_reason "max_turns", exit 1).
export function isMaxTurnsStop(summary) {
  return Boolean(summary) && (summary.terminalReason === "max_turns" || summary.subtype === "error_max_turns");
}

/**
 * Build the `claude` argv. Variadic flags (`--tools`, `--allowedTools`) always
 * use the `--flag=value` form so they cannot swallow other arguments, and the
 * prompt goes last after `--` so a prompt that starts with "-" is not parsed as
 * an option. With `promptViaStdin` the prompt is omitted and must be written to
 * the child's stdin instead (for prompts too large for a single argv entry).
 * `maxTurns` (null = no cap flag) adds `--max-turns <n>` right after
 * `--strict-mcp-config`.
 */
export function buildClaudeArgs({
  prompt,
  model,
  profile = "read",
  bashAllow,
  resumeSessionId = null,
  outputFormat = "json",
  promptViaStdin = false,
  maxTurns = null
} = {}) {
  if (!model) {
    throw new Error("buildClaudeArgs requires a model.");
  }
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildClaudeArgs requires a non-empty prompt.");
  }
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`Unsupported output format "${outputFormat}".`);
  }
  const maxTurnsValue = normalizeMaxTurns(maxTurns);
  const permissions = typeof profile === "object" ? profile : buildPermissionProfile(profile, { bashAllow });

  const args = [
    "-p",
    "--restricted",
    "--strict-mcp-config",
    ...(maxTurnsValue !== null ? ["--max-turns", String(maxTurnsValue)] : []),
    "--model",
    model,
    `--tools=${permissions.tools.join(",")}`,
    "--permission-mode",
    "dontAsk",
    `--allowedTools=${permissions.allowedTools.join(",")}`,
    "--output-format",
    outputFormat
  ];
  if (outputFormat === "stream-json") {
    args.push("--verbose");
  }
  if (resumeSessionId) {
    args.push("--resume", String(resumeSessionId));
  }
  if (!promptViaStdin) {
    args.push("--", prompt);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Prompt sizing / inline rendering helpers
// ---------------------------------------------------------------------------

// Upper bound, in UTF-8 bytes, on a prompt passed as a single argv entry
// (Linux caps one argument at 128 KiB). Larger prompts are piped through stdin.
export const PROMPT_ARGV_LIMIT = 64 * 1024;

/**
 * True when the prompt must go to claude's stdin rather than argv: always on
 * Windows (spawn goes through a shell there, so argv text would be parsed by
 * cmd.exe), otherwise when it exceeds PROMPT_ARGV_LIMIT bytes.
 */
export function shouldSendPromptViaStdin(prompt, platform = process.platform) {
  return platform === "win32" || Buffer.byteLength(String(prompt ?? ""), "utf8") > PROMPT_ARGV_LIMIT;
}

// Default cap for inline (in-rendered-message) result output, overridable via
// NANO_MAX_INLINE_CHARS.
export const DEFAULT_MAX_INLINE_CHARS = 8000;

export function resolveMaxInlineChars(env = process.env) {
  const value = Number.parseInt(env.NANO_MAX_INLINE_CHARS, 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_MAX_INLINE_CHARS;
}

// ---------------------------------------------------------------------------
// claude stdout/stderr parsing
// ---------------------------------------------------------------------------

const NOISE_LINE_PATTERNS = [
  /\[claude-code:unrecognized_model\]/,
  /claude\.ai connectors are disabled/
];

/**
 * Drop harmless noise lines real `claude` prints on stderr (an
 * unrecognized-model warning and a "connectors are disabled" notice). The
 * remaining lines are joined and right-trimmed.
 */
export function filterClaudeStderr(text) {
  const lines = String(text ?? "").split("\n");
  const kept = [];
  for (const line of lines) {
    if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

/**
 * Parse the stdout of a `claude -p --output-format json` run. Returns the
 * result object, or null when there is no parseable JSON. When the whole
 * trimmed stdout is a single JSON object it is returned directly; otherwise
 * lines are scanned last-to-first for a JSON object whose `type === "result"`.
 */
export function parseClaudeJsonOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const whole = JSON.parse(trimmed);
    if (whole !== null && typeof whole === "object" && !Array.isArray(whole) && whole.type === "result") {
      return whole;
    }
  } catch {
    // fall through to line scan
  }
  const lines = trimmed.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.type === "result") {
        return parsed;
      }
    } catch {
      // ignore unparseable lines
    }
  }
  return null;
}

/**
 * Short progress text for a `tool_use` content block, suitable for a progress
 * line. File paths are relativized to `options.cwd` when inside it.
 */
export function describeToolUse(name, input = {}, options = {}) {
  const cwd = options.cwd ?? null;
  let text;
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      let p = input.file_path ?? input.notebook_path ?? "";
      if (cwd && typeof p === "string" && path.isAbsolute(p)) {
        const rel = path.relative(cwd, p);
        if (!rel.startsWith("..")) {
          p = rel;
        }
      }
      text = `${name} ${p ?? ""}`;
      break;
    }
    case "Bash": {
      const command = String(input.command ?? "");
      const firstLine = command.split("\n", 1)[0];
      text = `Bash ${firstLine}`;
      break;
    }
    case "Glob": {
      text = `Glob ${input.pattern ?? ""}`;
      break;
    }
    case "Grep": {
      text = `Grep ${input.pattern ?? ""}`;
      if (input.path) {
        text += ` in ${input.path}`;
      }
      break;
    }
    default:
      text = String(name ?? "");
  }
  text = String(text).replace(/\s+/g, " ").trim();
  if (text.length > 120) {
    text = `${text.slice(0, 119)}…`;
  }
  return text;
}

// True for progress lines describeToolUse produces, i.e. lines that start with
// a tool name. Used to flip a background job's phase to "running" and to infer
// phases for job records written before `phase` was stored.
const TOOL_PROGRESS_LINE_PATTERN = /^(Read|Glob|Grep|Edit|Write|Bash|NotebookEdit)(\s|$)/;

export function isToolUseProgressLine(text) {
  return TOOL_PROGRESS_LINE_PATTERN.test(String(text ?? "").trim());
}

/**
 * Parse one `--output-format stream-json --verbose` line into a normalized
 * shape: `{ event, sessionId, progress, result }`. Returns null for blank or
 * non-JSON lines.
 */
export function parseStreamEvent(line, options = {}) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return null;
  }
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const sessionId = event.session_id ?? null;
  let progress = [];
  if (event.type === "system" && event.subtype === "init") {
    progress = [`NanoGPT session ${event.session_id ?? "?"} started (model ${event.model ?? "?"})`];
  } else if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      progress = content
        .filter((block) => block && block.type === "tool_use")
        .map((block) => describeToolUse(block.name, block.input, options));
    }
  }
  const result = event.type === "result" ? event : null;
  return { event, sessionId, progress, result };
}

/**
 * Reduce a `claude` result object to the plain shape the companion uses.
 */
export function summarizeClaudeResult(result) {
  const usage = result && typeof result.usage === "object" && !Array.isArray(result.usage) ? { ...result.usage } : {};
  return {
    text: typeof result.result === "string" ? result.result : "",
    isError: result.is_error === true,
    subtype: result.subtype ?? null,
    terminalReason: result.terminal_reason ?? null,
    sessionId: result.session_id ?? null,
    numTurns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    usage,
    permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : []
  };
}

// ---------------------------------------------------------------------------
// run metrics log (mirrors bin/nano-agent's runs.jsonl)
// ---------------------------------------------------------------------------

export function resolveRunLogFile(env = process.env) {
  return path.join(env.CLAUDE_PLUGIN_DATA || resolveFallbackDataDir(), "runs.jsonl");
}

export function buildRunLogEntry({ model, cwd, allowedTools = [], task = "", summary, quotaDelta = null, now = new Date() }) {
  return {
    ts: now.toISOString(),
    model,
    cwd,
    tools: allowedTools.join(","),
    is_error: summary.isError,
    turns: summary.numTurns,
    in: summary.usage.input_tokens ?? 0,
    cache_read: summary.usage.cache_read_input_tokens ?? 0,
    out: summary.usage.output_tokens ?? 0,
    ms: summary.durationMs,
    denials: summary.permissionDenials.length,
    session: summary.sessionId,
    quotaDelta,
    task: String(task).slice(0, 300)
  };
}

/**
 * Append a run-log entry as one JSON line. Never throws: returns the file
 * path on success or null on any error.
 */
export function appendRunLog(entry, options = {}) {
  try {
    const env = options.env ?? process.env;
    const file = resolveRunLogFile(env);
    if (env.CLAUDE_PLUGIN_DATA) {
      mkdirSync(path.dirname(file), { recursive: true });
    } else {
      ensurePrivateDir(path.dirname(file));
    }
    appendFileSync(file, JSON.stringify(entry) + "\n");
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runClaude: spawn `claude -p` headless and collect its output
// ---------------------------------------------------------------------------

/**
 * Spawn `claude` with the given argv and return a promise resolving on close
 * to `{ status, signal, stdout, stderr, pid }`. `stderr` has noise lines
 * filtered out. When `input` is provided it is written to stdin (otherwise
 * stdin is "ignore" so claude does not wait 3s for input). `onStdoutLine` is
 * called for each complete stdout line and any trailing partial line.
 */
export function runClaude({ cwd, args, env, input = null, onStdoutLine = null, onSpawn = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    if (onSpawn) {
      onSpawn(child);
    }

    let stdout = "";
    let stderr = "";
    let stdoutPartial = "";

    if (input != null && child.stdin) {
      // If claude exits (or its stdin pipe otherwise breaks) before we finish
      // writing, Node emits an EPIPE `error` event on the stream. Without a
      // handler that is an uncaught exception that crashes the companion; a
      // no-op handler lets the `close` handler below report the failure
      // through the normal exitStatus/stderr path instead.
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(input);
      } catch {
        // best-effort; ignore write errors
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutPartial += chunk;
      const lines = stdoutPartial.split("\n");
      stdoutPartial = lines.pop() ?? "";
      for (const line of lines) {
        if (onStdoutLine) {
          onStdoutLine(line);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(new Error(`Could not start claude: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      if (stdoutPartial.length > 0 && onStdoutLine) {
        onStdoutLine(stdoutPartial);
      }
      resolve({
        status: signal ? 1 : (code ?? 1),
        signal: signal ?? null,
        stdout,
        stderr: filterClaudeStderr(stderr),
        pid: child.pid
      });
    });
  });
}
