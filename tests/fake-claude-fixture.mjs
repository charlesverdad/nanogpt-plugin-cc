import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_API_KEY = "nano-test-key-DO-NOT-LEAK-7f3a";

/**
 * Installs a fake `claude` (Claude Code) executable into `binDir`.
 *
 * The plugin shells out to `claude` running headless against NanoGPT:
 *
 *   - `claude --version`        -> availability check
 *   - `claude --help`           -> option/flag surface probe
 *   - `claude -p [--output-format json|stream-json] [--verbose]
 *          [--model m] [--tools t] [--allowedTools t]
 *          [--permission-mode m] [--resume id] [--restricted]
 *          [--strict-mcp-config] -- <prompt>` (or prompt via stdin)
 *                              -> task/review run; result JSON on stdout
 *
 * `behavior` selects the canned response set:
 *   - "ok"        (default) print a result object with is_error:false, exit 0.
 *   - "failure"   is_error:true result "API Error: simulated failure", exit 1.
 *   - "denials"   is_error:false with two permission_denials entries, exit 0.
 *   - "no-json"   print `this is not json` to stdout, exit 1.
 *   - "long"      like "ok" but result is 20000 "L" characters, exit 0.
 *   - "slow"      wait options.delayMs then behave like "ok".
 *   - "crash-after-init"  stream-json: print the init and one assistant
 *                 tool_use line, then exit 1 with NO result object (json:
 *                 print nothing, exit 1). Simulates claude dying mid-run.
 *
 * Each run-mode invocation appends ONE JSON line to
 * `<binDir>/claude-invocations.log` recording the argv it received and decoded
 * fields, so tests can assert that --model / --tools / --permission-mode etc.
 * are forwarded correctly. Secret env values (ANTHROPIC_API_KEY,
 * NANOGPT_API_KEY, ANTHROPIC_AUTH_TOKEN) are NEVER written to the log.
 *
 * `options.version` (default "2.1.278") overrides the --version string.
 * `options.resultText` overrides the "ok" result text.
 * `options.delayMs` (default 5000) is used by behavior "slow".
 */
export function installFakeClaude(binDir, behavior = "ok", options = {}) {
  const version = options.version ?? "2.1.278";
  const resultText = options.resultText ?? null;
  const delayMs = options.delayMs ?? 5000;
  const invocationsLog = path.join(binDir, "claude-invocations.log");
  const scriptPath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const BEHAVIOR = ${JSON.stringify(behavior)};
const VERSION = ${JSON.stringify(version)};
const RESULT_TEXT = ${JSON.stringify(resultText)};
const DELAY_MS = ${JSON.stringify(delayMs)};
const INVOCATIONS_LOG = ${JSON.stringify(invocationsLog)};

const argv = process.argv.slice(2);

// fs.readFileSync(0) throws EAGAIN on a non-blocking pipe whose writer has not
// finished (large prompts), so read in a loop.
function readAllStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error && error.code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      if (error && error.code === "EOF") {
        break;
      }
      throw error;
    }
    if (n === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- --version / --help -----------------------------------------------------

if (argv[0] === "--version" || argv[0] === "-v") {
  console.log(VERSION + " (Claude Code)");
  process.exit(0);
}

if (argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write([
    "Usage: claude [options] [command]",
    "",
    "Options:",
    "  -p, --print                      run without interactive UI",
    "  --restricted                     restrict tool access",
    "  --strict-mcp-config              fail when MCP config is invalid",
    "  --tools <tools...>               tools to enable",
    "  --permission-mode <mode>         permission mode (" + '"acceptEdits"' + ", " + '"auto"' + ", " + '"bypassPermissions"' + ", " + '"default"' + ", " + '"dontAsk"' + ", " + '"plan"' + ")",
    "  --allowedTools, --allowed-tools <tools...>  tools to allow",
    "  --output-format <format>         output format (" + '"text"' + ", " + '"json"' + ", " + '"stream-json"' + ")",
    "  --verbose                        verbose output",
    "  -r, --resume [value]             resume a session",
    "  --model <model>                  model to use",
    "  -v, --version                    print version",
    "",
    "Commands:",
    "  claude [options]                 start interactive session",
    ""
  ].join("\\n"));
  process.exit(0);
}

// --- Run mode (-p / --print) ------------------------------------------------

function isRun() {
  return argv.includes("-p") || argv.includes("--print");
}

function parseRunArgs(args) {
  const parsed = {
    model: null,
    tools: null,
    allowedTools: null,
    permissionMode: null,
    outputFormat: null,
    verbose: false,
    resume: null,
    restricted: false,
    strictMcpConfig: false,
    print: false,
    prompt: null
  };
  let sawDashDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (sawDashDash) {
      if (parsed.prompt === null) parsed.prompt = token;
      continue;
    }
    if (token === "--") {
      sawDashDash = true;
      continue;
    }
    if (token === "-p" || token === "--print") parsed.print = true;
    else if (token === "--verbose") parsed.verbose = true;
    else if (token === "--restricted") parsed.restricted = true;
    else if (token === "--strict-mcp-config") parsed.strictMcpConfig = true;
    else if (token === "--model") {
      parsed.model = args[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith("--model=")) {
      parsed.model = token.slice("--model=".length);
    } else if (token === "--tools") {
      parsed.tools = args[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith("--tools=")) {
      parsed.tools = token.slice("--tools=".length);
    } else if (token === "--allowedTools" || token === "--allowed-tools") {
      parsed.allowedTools = args[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith("--allowedTools=")) {
      parsed.allowedTools = token.slice("--allowedTools=".length);
    } else if (token.startsWith("--allowed-tools=")) {
      parsed.allowedTools = token.slice("--allowed-tools=".length);
    } else if (token === "--permission-mode") {
      parsed.permissionMode = args[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith("--permission-mode=")) {
      parsed.permissionMode = token.slice("--permission-mode=".length);
    } else if (token === "--output-format") {
      parsed.outputFormat = args[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith("--output-format=")) {
      parsed.outputFormat = token.slice("--output-format=".length);
    } else if (token === "--resume" || token === "-r") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        parsed.resume = next;
        i += 1;
      } else {
        parsed.resume = "";
      }
    } else if (token.startsWith("--resume=")) {
      parsed.resume = token.slice("--resume=".length);
    }
  }
  if (parsed.prompt === null && !sawDashDash) {
    try {
      parsed.prompt = readAllStdin();
    } catch (e) {
      parsed.prompt = "";
    }
  }
  return parsed;
}

const run = parseRunArgs(argv);

if (!isRun()) {
  process.stderr.write("fake claude: unsupported invocation\\n");
  process.exit(2);
}

if (run.outputFormat === "stream-json" && !run.verbose) {
  process.stderr.write("Error: When using --print, --output-format=stream-json requires --verbose\\n");
  process.exit(1);
}

// session id
let sessionId = run.resume;
if (sessionId === null || sessionId === "") {
  sessionId = "fake-session-" + Math.random().toString(16).slice(2);
}

const ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "NANOGPT_API_KEY"
];

const envNames = ENV_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(process.env, name)).sort();

const envValues = {};
for (const name of ["ANTHROPIC_BASE_URL", "API_TIMEOUT_MS", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    envValues[name] = process.env[name];
  }
}

const apiKeyMatchesFake = process.env.ANTHROPIC_API_KEY === "nano-test-key-DO-NOT-LEAK-7f3a";

function recordInvocation() {
  const entry = {
    argv: argv,
    pid: process.pid,
    cwd: process.cwd(),
    prompt: run.prompt,
    model: run.model,
    tools: run.tools,
    allowedTools: run.allowedTools,
    permissionMode: run.permissionMode,
    outputFormat: run.outputFormat,
    verbose: run.verbose,
    resume: run.resume,
    restricted: run.restricted,
    strictMcpConfig: run.strictMcpConfig,
    envNames: envNames,
    env: envValues,
    apiKeyMatchesFake: apiKeyMatchesFake
  };
  try {
    fs.appendFileSync(INVOCATIONS_LOG, JSON.stringify(entry) + "\\n", "utf8");
  } catch (error) {
    // best-effort
  }
}

// Always print the noise line that real claude prints and the plugin filters.
process.stderr.write('[claude-code:unrecognized_model] {"model":' + JSON.stringify(run.model) + ',"query_source":"sdk"}\\n');

function buildResultObject() {
  const isSlow = BEHAVIOR === "slow";
  const effBehavior = isSlow ? "ok" : BEHAVIOR;
  let is_error = false;
  let result;
  let permission_denials = [];
  let exitCode = 0;

  if (effBehavior === "ok") {
    is_error = false;
    if (RESULT_TEXT !== null) {
      result = RESULT_TEXT;
    } else {
      const head = (run.prompt || "").slice(0, 60);
      result = "Fake NanoGPT result.\\nHandled: " + head;
      if (run.resume !== null && run.resume !== "") {
        result += "\\nResumed session " + run.resume;
      }
    }
    permission_denials = [];
    exitCode = 0;
  } else if (effBehavior === "failure") {
    is_error = true;
    result = "API Error: simulated failure";
    permission_denials = [];
    exitCode = 1;
  } else if (effBehavior === "denials") {
    is_error = false;
    result = "Tried to run commands.";
    permission_denials = [
      { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
      { tool_name: "Write", tool_input: { file_path: "/outside/escape.txt", content: "x" } }
    ];
    exitCode = 0;
  } else if (effBehavior === "no-json") {
    process.stdout.write("this is not json\\n");
    process.exit(1);
  } else if (effBehavior === "long") {
    is_error = false;
    result = "L".repeat(20000);
    permission_denials = [];
    exitCode = 0;
  }

  return {
    type: "result",
    subtype: "success",
    is_error: is_error,
    result: result,
    session_id: sessionId,
    num_turns: 3,
    duration_ms: 1234,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0
    },
    permission_denials: permission_denials,
    total_cost_usd: 0.5,
    modelUsage: {},
    _exitCode: exitCode
  };
}

function emitStreamLines(resultObject) {
  const cwd = process.cwd();
  const lines = [];
  lines.push({ type: "system", subtype: "init", session_id: sessionId, model: run.model, cwd: cwd });
  lines.push({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [
    { type: "text", text: "Looking around." },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: cwd + "/README.md" } }
  ] } });
  lines.push({ type: "user", session_id: sessionId, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }
  ] } });
  lines.push({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [
    { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "git diff --stat" } }
  ] } });
  lines.push(resultObject);
  return lines;
}

function finish() {
  const resultObject = buildResultObject();
  const exitCode = resultObject._exitCode;
  delete resultObject._exitCode;

  recordInvocation();

  if (run.outputFormat === "stream-json") {
    const lines = emitStreamLines(resultObject);
    for (const line of lines) {
      process.stdout.write(JSON.stringify(line) + "\\n");
    }
  } else {
    // default json for our purposes (and text -> just result)
    process.stdout.write(JSON.stringify(resultObject) + "\\n");
  }
  process.exit(exitCode);
}

if (BEHAVIOR === "crash-after-init") {
  recordInvocation();
  if (run.outputFormat === "stream-json") {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: run.model, cwd: process.cwd() }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: process.cwd() + "/README.md" } }
    ] } }) + "\\n");
  }
  process.stderr.write("fake claude: crashed\\n");
  process.exit(1);
} else if (BEHAVIOR === "slow" && run.outputFormat === "stream-json") {
  // Record the invocation (including pid) and print the init line BEFORE
  // waiting, so tests can observe and cancel the still-running process.
  recordInvocation();
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: run.model, cwd: process.cwd() }) + "\\n");
  setTimeout(function () {
    const resultObject = buildResultObject();
    const exitCode = resultObject._exitCode;
    delete resultObject._exitCode;
    const lines = emitStreamLines(resultObject);
    // Skip the first init line since we already printed it.
    for (let i = 1; i < lines.length; i += 1) {
      process.stdout.write(JSON.stringify(lines[i]) + "\\n");
    }
    process.exit(exitCode);
  }, DELAY_MS);
} else if (BEHAVIOR === "slow") {
  setTimeout(function () {
    finish();
  }, DELAY_MS);
} else {
  finish();
}
`;
  writeExecutable(scriptPath, source);

  // On Windows, spawn() resolves global binaries via .cmd wrappers.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0claude" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "claude.cmd"), cmdWrapper, { encoding: "utf8" });
  }

  return { scriptPath, invocationsLog };
}

/**
 * Builds an env that:
 *   - puts the fake `claude` first on PATH, and
 *   - redirects companion state into `dataDir` (CLAUDE_PLUGIN_DATA) so tests
 *     never touch real plugin state.
 *   - sets NANOGPT_API_KEY / NANOGPT_BASE_URL to point at an unreachable
 *     endpoint so nothing touches the network.
 *   - simulates a host environment (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL)
 *     that the plugin is expected to strip before spawning claude.
 *
 * `dataDir` is optional; when omitted CLAUDE_PLUGIN_DATA is deleted.
 * `extra` overrides individual env vars (a value of undefined/null deletes).
 */
export function buildEnv(binDir, dataDir, extra = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    NANOGPT_API_KEY: FAKE_API_KEY,
    NANOGPT_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_AUTH_TOKEN: "host-auth-token",
    ANTHROPIC_MODEL: "claude-host-model"
  };
  if (dataDir) {
    env.CLAUDE_PLUGIN_DATA = dataDir;
  } else {
    delete env.CLAUDE_PLUGIN_DATA;
  }
  delete env.NANO_COMPANION_SESSION_ID;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Reads the recorded run invocations (argv + decoded fields).
 */
export function readInvocations(invocationsLog) {
  if (!fs.existsSync(invocationsLog)) {
    return [];
  }
  return fs
    .readFileSync(invocationsLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
