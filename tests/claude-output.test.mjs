import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import {
  installFakeClaude,
  buildEnv,
  readInvocations
} from "./fake-claude-fixture.mjs";

import {
  PROMPT_ARGV_LIMIT,
  DEFAULT_MAX_INLINE_CHARS,
  resolveMaxInlineChars,
  filterClaudeStderr,
  parseClaudeJsonOutput,
  describeToolUse,
  parseStreamEvent,
  summarizeClaudeResult,
  resolveRunLogFile,
  buildRunLogEntry,
  buildRunErrorText,
  buildPingLogEntry,
  createCallTracker,
  readTranscriptUsage,
  resolveSessionTranscript,
  percentile,
  appendRunLog,
  runClaude,
  buildClaudeArgs,
  shouldSendPromptViaStdin
} from "../plugins/nano/scripts/lib/runtime.mjs";

import {
  formatDenials,
  renderRunFooter,
  truncateInline
} from "../plugins/nano/scripts/lib/render.mjs";

// ---------------------------------------------------------------------------
// constants & resolveMaxInlineChars
// ---------------------------------------------------------------------------

test("PROMPT_ARGV_LIMIT and DEFAULT_MAX_INLINE_CHARS are exported constants", () => {
  assert.equal(typeof PROMPT_ARGV_LIMIT, "number");
  assert.equal(PROMPT_ARGV_LIMIT, 64 * 1024);
  assert.equal(typeof DEFAULT_MAX_INLINE_CHARS, "number");
  assert.equal(DEFAULT_MAX_INLINE_CHARS, 8000);
});

test("resolveMaxInlineChars returns env value when finite and positive", () => {
  assert.equal(resolveMaxInlineChars({ NANO_MAX_INLINE_CHARS: "12345" }), 12345);
});

test("resolveMaxInlineChars falls back to default for invalid values", () => {
  assert.equal(resolveMaxInlineChars({}), DEFAULT_MAX_INLINE_CHARS);
  assert.equal(resolveMaxInlineChars({ NANO_MAX_INLINE_CHARS: "0" }), DEFAULT_MAX_INLINE_CHARS);
  assert.equal(resolveMaxInlineChars({ NANO_MAX_INLINE_CHARS: "-5" }), DEFAULT_MAX_INLINE_CHARS);
  assert.equal(resolveMaxInlineChars({ NANO_MAX_INLINE_CHARS: "abc" }), DEFAULT_MAX_INLINE_CHARS);
  assert.equal(resolveMaxInlineChars({ NANO_MAX_INLINE_CHARS: "NaN" }), DEFAULT_MAX_INLINE_CHARS);
});

// ---------------------------------------------------------------------------
// filterClaudeStderr
// ---------------------------------------------------------------------------

test("filterClaudeStderr drops noise lines and trims the end", () => {
  const stderr = [
    '[claude-code:unrecognized_model] {"model":"x"}',
    "some real warning",
    "claude.ai connectors are disabled",
    "another line",
    ""
  ].join("\n");
  assert.equal(filterClaudeStderr(stderr), "some real warning\nanother line");
});

test("filterClaudeStderr returns empty string for all-noise input", () => {
  const stderr = '[claude-code:unrecognized_model] x\nclaude.ai connectors are disabled\n';
  assert.equal(filterClaudeStderr(stderr), "");
});

test("filterClaudeStderr handles null/undefined input", () => {
  assert.equal(filterClaudeStderr(undefined), "");
  assert.equal(filterClaudeStderr(null), "");
});

// ---------------------------------------------------------------------------
// parseClaudeJsonOutput
// ---------------------------------------------------------------------------

test("parseClaudeJsonOutput returns null for empty input", () => {
  assert.equal(parseClaudeJsonOutput(""), null);
  assert.equal(parseClaudeJsonOutput("   \n  "), null);
  assert.equal(parseClaudeJsonOutput(null), null);
});

test("parseClaudeJsonOutput parses a single whole-object result", () => {
  const obj = { type: "result", subtype: "success", is_error: false, result: "hi", num_turns: 2 };
  const parsed = parseClaudeJsonOutput(JSON.stringify(obj));
  assert.deepEqual(parsed, obj);
});

test("parseClaudeJsonOutput scans lines last-to-first for a result object", () => {
  const stdout = [
    "some preamble line",
    '{"type":"assistant","message":{}}',
    '{"type":"result","is_error":false,"result":"final"}'
  ].join("\n");
  const parsed = parseClaudeJsonOutput(stdout);
  assert.equal(parsed.type, "result");
  assert.equal(parsed.result, "final");
});

test("parseClaudeJsonOutput returns the result object even when not the last JSON line", () => {
  const stdout = '{"type":"result","result":"x"}\n{"type":"other"}';
  const parsed = parseClaudeJsonOutput(stdout);
  assert.equal(parsed.type, "result");
  assert.equal(parsed.result, "x");
});

test("parseClaudeJsonOutput returns null when no result object is present", () => {
  const stdout = '{"type":"assistant"}\n{"type":"user"}';
  assert.equal(parseClaudeJsonOutput(stdout), null);
});

test("parseClaudeJsonOutput ignores non-object JSON", () => {
  const stdout = '[1,2,3]\n{"type":"result","result":"ok"}';
  const parsed = parseClaudeJsonOutput(stdout);
  assert.equal(parsed.type, "result");
  assert.equal(parsed.result, "ok");
});

test("parseClaudeJsonOutput returns null for non-json input", () => {
  assert.equal(parseClaudeJsonOutput("this is not json"), null);
});

test("parseClaudeJsonOutput returns null for a single JSON object that is not a result", () => {
  // e.g. a stream-json run that died right after its init event
  assert.equal(parseClaudeJsonOutput('{"type":"system","subtype":"init","session_id":"s1"}'), null);
  assert.equal(parseClaudeJsonOutput('{"error":"boom"}'), null);
});

// ---------------------------------------------------------------------------
// shouldSendPromptViaStdin
// ---------------------------------------------------------------------------

test("shouldSendPromptViaStdin: small prompts stay in argv off Windows", () => {
  assert.equal(shouldSendPromptViaStdin("hello", "linux"), false);
  assert.equal(shouldSendPromptViaStdin("a".repeat(PROMPT_ARGV_LIMIT), "darwin"), false);
  assert.equal(shouldSendPromptViaStdin("a".repeat(PROMPT_ARGV_LIMIT + 1), "linux"), true);
});

test("shouldSendPromptViaStdin: the limit counts UTF-8 bytes, not characters", () => {
  // 30k three-byte characters: well under the limit in characters, ~90 KiB in bytes.
  const prompt = "\u4e2d".repeat(30000);
  assert.ok(prompt.length < PROMPT_ARGV_LIMIT);
  assert.equal(shouldSendPromptViaStdin(prompt, "linux"), true);
});

test("shouldSendPromptViaStdin: always stdin on Windows", () => {
  assert.equal(shouldSendPromptViaStdin("hi", "win32"), true);
});

// ---------------------------------------------------------------------------
// describeToolUse
// ---------------------------------------------------------------------------

test("describeToolUse formats file tools with relative path inside cwd", () => {
  const cwd = "/tmp/repo";
  assert.equal(
    describeToolUse("Read", { file_path: "/tmp/repo/README.md" }, { cwd }),
    "Read README.md"
  );
});

test("describeToolUse keeps absolute path when outside cwd", () => {
  const cwd = "/tmp/repo";
  assert.equal(
    describeToolUse("Write", { file_path: "/etc/hosts" }, { cwd }),
    "Write /etc/hosts"
  );
});

test("describeToolUse falls back to notebook_path for NotebookEdit", () => {
  assert.equal(
    describeToolUse("NotebookEdit", { notebook_path: "nb.ipynb" }, {}),
    "NotebookEdit nb.ipynb"
  );
});

test("describeToolUse Bash uses only the first line of the command", () => {
  assert.equal(
    describeToolUse("Bash", { command: "git diff --stat\necho more" }, {}),
    "Bash git diff --stat"
  );
});

test("describeToolUse Glob uses the pattern", () => {
  assert.equal(describeToolUse("Glob", { pattern: "**/*.mjs" }, {}), "Glob **/*.mjs");
});

test("describeToolUse Grep appends path when set", () => {
  assert.equal(describeToolUse("Grep", { pattern: "foo", path: "src" }, {}), "Grep foo in src");
  assert.equal(describeToolUse("Grep", { pattern: "foo" }, {}), "Grep foo");
});

test("describeToolUse unknown tool yields just the name", () => {
  assert.equal(describeToolUse("WebFetch", {}, {}), "WebFetch");
});

test("describeToolUse collapses whitespace and caps at 120 chars", () => {
  const long = describeToolUse("Bash", { command: "echo   " + "x".repeat(200) }, {});
  assert.ok(long.length <= 120, `len=${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("  "));
});

// ---------------------------------------------------------------------------
// parseStreamEvent
// ---------------------------------------------------------------------------

test("parseStreamEvent returns null for blank or invalid JSON", () => {
  assert.equal(parseStreamEvent(""), null);
  assert.equal(parseStreamEvent("   "), null);
  assert.equal(parseStreamEvent("not json"), null);
  assert.equal(parseStreamEvent("[1,2,3]"), null);
  assert.equal(parseStreamEvent("null"), null);
  assert.equal(parseStreamEvent('"string"'), null);
});

test("parseStreamEvent init event produces a progress line", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" });
  const parsed = parseStreamEvent(line);
  assert.equal(parsed.event.type, "system");
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.result, null);
  assert.deepEqual(parsed.progress, ["NanoGPT session s1 started (model m1)"]);
});

test("parseStreamEvent assistant event describes each tool_use block", () => {
  const event = {
    type: "assistant",
    session_id: "s2",
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Bash", input: { command: "git status" } },
        { type: "tool_use", name: "Read", input: { file_path: "/abs/README.md" } }
      ]
    }
  };
  const parsed = parseStreamEvent(JSON.stringify(event), { cwd: "/abs" });
  assert.equal(parsed.sessionId, "s2");
  assert.equal(parsed.result, null);
  assert.deepEqual(parsed.progress, ["Bash git status", "Read README.md"]);
});

test("parseStreamEvent assistant event with no tool_use yields empty progress", () => {
  const event = { type: "assistant", session_id: "s3", message: { content: [{ type: "text", text: "hi" }] } };
  const parsed = parseStreamEvent(JSON.stringify(event));
  assert.deepEqual(parsed.progress, []);
});

test("parseStreamEvent user event yields empty progress", () => {
  const event = { type: "user", session_id: "s4", message: { content: [{ type: "tool_result", content: "ok" }] } };
  const parsed = parseStreamEvent(JSON.stringify(event));
  assert.deepEqual(parsed.progress, []);
});

test("parseStreamEvent result event is captured in result", () => {
  const event = { type: "result", session_id: "s5", is_error: false, result: "done" };
  const parsed = parseStreamEvent(JSON.stringify(event));
  assert.equal(parsed.result, parsed.event);
  assert.equal(parsed.result.type, "result");
  assert.equal(parsed.result.result, "done");
  assert.deepEqual(parsed.progress, []);
});

// ---------------------------------------------------------------------------
// summarizeClaudeResult
// ---------------------------------------------------------------------------

test("summarizeClaudeResult maps fields into the companion shape", () => {
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "final text",
    session_id: "sid",
    num_turns: 3,
    duration_ms: 1234,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm" } }]
  };
  const summary = summarizeClaudeResult(result);
  assert.equal(summary.text, "final text");
  assert.equal(summary.isError, false);
  assert.equal(summary.subtype, "success");
  assert.equal(summary.terminalReason, null);
  assert.equal(summary.sessionId, "sid");
  assert.equal(summary.numTurns, 3);
  assert.equal(summary.durationMs, 1234);
  assert.deepEqual(summary.usage, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 });
  assert.deepEqual(summary.permissionDenials, [{ tool_name: "Bash", tool_input: { command: "rm" } }]);
});

test("summarizeClaudeResult defaults missing fields", () => {
  const summary = summarizeClaudeResult({ result: 123 });
  assert.equal(summary.text, "");
  assert.equal(summary.isError, false);
  assert.equal(summary.subtype, null);
  assert.equal(summary.terminalReason, null);
  assert.equal(summary.sessionId, null);
  assert.equal(summary.numTurns, null);
  assert.equal(summary.durationMs, null);
  assert.deepEqual(summary.usage, {});
  assert.deepEqual(summary.permissionDenials, []);
});

test("summarizeClaudeResult copies usage object (no shared reference)", () => {
  const usage = { input_tokens: 1 };
  const summary = summarizeClaudeResult({ result: "", usage });
  assert.notEqual(summary.usage, usage);
  assert.deepEqual(summary.usage, usage);
});

// ---------------------------------------------------------------------------
// resolveRunLogFile / buildRunLogEntry / appendRunLog
// ---------------------------------------------------------------------------

test("resolveRunLogFile uses CLAUDE_PLUGIN_DATA when set", () => {
  assert.equal(resolveRunLogFile({ CLAUDE_PLUGIN_DATA: "/data" }), path.join("/data", "runs.jsonl"));
});

test("resolveRunLogFile falls back to a per-user tmpdir/nano-companion-<uid>", () => {
  const owner = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  assert.equal(
    resolveRunLogFile({}),
    path.join(os.tmpdir(), `nano-companion-${owner}`, "runs.jsonl")
  );
});

test("buildRunLogEntry mirrors bin/nano-agent field names and order", () => {
  const now = new Date("2026-01-02T03:04:05.678Z");
  const summary = {
    isError: false,
    numTurns: 3,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
    durationMs: 1234,
    permissionDenials: [{ tool_name: "Bash", tool_input: { command: "rm -rf x" } }],
    sessionId: "sid-1"
  };
  const entry = buildRunLogEntry({
    model: "z-ai/glm-5.2",
    cwd: "/repo",
    allowedTools: ["Read", "Glob"],
    task: "do something",
    summary,
    now
  });
  assert.deepEqual(Object.keys(entry), [
    "ts",
    "model",
    "cwd",
    "tools",
    "is_error",
    "turns",
    "in",
    "cache_read",
    "out",
    "ms",
    "denials",
    "session",
    "quotaDelta",
    "task",
    "kind",
    "jobId",
    "exit",
    "subtype",
    "terminalReason",
    "stopReason",
    "error",
    "cache_creation",
    "promptBytes",
    "spilledDiffBytes",
    "wallMs",
    "maxTurns",
    "salvaged",
    "salvage",
    "calls",
    "callMsMax",
    "callMsP50"
  ]);
  assert.deepEqual(entry, {
    ts: "2026-01-02T03:04:05.678Z",
    model: "z-ai/glm-5.2",
    cwd: "/repo",
    tools: "Read,Glob",
    is_error: false,
    turns: 3,
    in: 1000,
    cache_read: 500,
    out: 200,
    ms: 1234,
    denials: 1,
    session: "sid-1",
    quotaDelta: null,
    task: "do something",
    kind: null,
    jobId: null,
    exit: null,
    subtype: null,
    terminalReason: null,
    stopReason: null,
    error: null,
    cache_creation: 0,
    promptBytes: null,
    spilledDiffBytes: null,
    wallMs: null,
    maxTurns: null,
    salvaged: null,
    salvage: null,
    calls: [],
    callMsMax: null,
    callMsP50: null
  });
});

test("buildRunLogEntry records a quotaDelta when given one", () => {
  const now = new Date("2026-01-02T03:04:05.678Z");
  const summary = {
    isError: false,
    numTurns: 3,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
    durationMs: 1234,
    permissionDenials: [],
    sessionId: "sid-1"
  };
  const entry = buildRunLogEntry({
    model: "z-ai/glm-5.2",
    cwd: "/repo",
    allowedTools: ["Read"],
    task: "do something",
    summary,
    quotaDelta: 1200000,
    now
  });
  assert.equal(entry.quotaDelta, 1200000);
});

test("buildRunLogEntry defaults missing usage values to 0 and truncates task", () => {
  const entry = buildRunLogEntry({
    model: "m",
    cwd: "/r",
    allowedTools: [],
    task: "x".repeat(500),
    summary: { isError: true, numTurns: null, usage: {}, durationMs: null, permissionDenials: [], sessionId: null },
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert.equal(entry.is_error, true);
  assert.equal(entry.turns, null);
  assert.equal(entry.in, 0);
  assert.equal(entry.cache_read, 0);
  assert.equal(entry.out, 0);
  assert.equal(entry.ms, null);
  assert.equal(entry.denials, 0);
  assert.equal(entry.session, null);
  assert.equal(entry.task.length, 300);
  assert.equal(entry.tools, "");
});

test("appendRunLog writes a JSON line and returns the file path", () => {
  const dataDir = makeTempDir("runlog-");
  const env = { CLAUDE_PLUGIN_DATA: dataDir };
  const entry = { ts: "t", model: "m", cwd: "/r", tools: "", is_error: false, turns: 1, in: 0, cache_read: 0, out: 0, ms: 1, denials: 0, session: "s", task: "x" };
  const file = appendRunLog(entry, { env });
  assert.equal(file, path.join(dataDir, "runs.jsonl"));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), entry);
});

test("appendRunLog creates nested directories", () => {
  const dataDir = makeTempDir("runlog-nested-");
  const env = { CLAUDE_PLUGIN_DATA: path.join(dataDir, "deep", "path") };
  const file = appendRunLog({ ts: "t" }, { env });
  assert.ok(file);
  assert.ok(fs.existsSync(file));
});

test("appendRunLog never throws and returns null on error", () => {
  // A non-writable CLAUDE_PLUGIN_DATA (a file, not a dir) forces mkdir to fail.
  const tmp = makeTempDir("runlog-fail-");
  const blocker = path.join(tmp, "blocker");
  fs.writeFileSync(blocker, "x");
  const env = { CLAUDE_PLUGIN_DATA: path.join(blocker, "sub") };
  const result = appendRunLog({ ts: "t" }, { env });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// render.mjs exports
// ---------------------------------------------------------------------------

test("formatDenials renders command detail and deduplicates", () => {
  const denials = [
    { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
    { tool_name: "Write", tool_input: { file_path: "/outside/escape.txt", content: "x" } },
    { tool_name: "Bash", tool_input: { command: "rm -rf build" } }
  ];
  assert.equal(formatDenials(denials), "Bash(rm -rf build), Write(/outside/escape.txt)");
});

test("formatDenials truncates long detail to ellipsis + last 59 chars", () => {
  const long = "x".repeat(80);
  const rendered = formatDenials([{ tool_name: "Bash", tool_input: { command: long } }]);
  assert.equal(rendered, `Bash(…${long.slice(-59)})`);
});

test("formatDenials falls back to pattern when no command/file_path", () => {
  assert.equal(
    formatDenials([{ tool_name: "Grep", tool_input: { pattern: "foo" } }]),
    "Grep(foo)"
  );
});

test("formatDenials handles empty and missing inputs", () => {
  assert.equal(formatDenials([]), "");
  assert.equal(formatDenials(undefined), "");
  assert.equal(formatDenials(null), "");
});

test("renderRunFooter matches the bin/nano-agent shape without denials", () => {
  const footer = renderRunFooter({
    model: "z-ai/glm-5.2",
    summary: {
      numTurns: 3,
      durationMs: 1234,
      sessionId: "sid",
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      permissionDenials: []
    }
  });
  assert.equal(
    footer,
    "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid"
  );
});

test("renderRunFooter appends denied= when there are denials", () => {
  const footer = renderRunFooter({
    model: "m",
    summary: {
      numTurns: 1,
      durationMs: 500,
      sessionId: "s",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
      permissionDenials: [{ tool_name: "Bash", tool_input: { command: "rm" } }]
    }
  });
  assert.equal(footer, "[nano] model=m turns=1 tokens=1in/2out secs=0 session=s denied=Bash(rm)");
});

test("renderRunFooter uses defaults for missing values", () => {
  const footer = renderRunFooter({ model: "m", summary: {} });
  assert.equal(footer, "[nano] model=m turns=? tokens=0in/0out secs=0 session=none");
});

const BASE_SUMMARY = {
  numTurns: 3,
  durationMs: 1234,
  sessionId: "sid",
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
  permissionDenials: []
};

test("renderRunFooter appends quota= and week= between session= and denied=, in order", () => {
  const footer = renderRunFooter({
    model: "z-ai/glm-5.2",
    summary: {
      ...BASE_SUMMARY,
      permissionDenials: [{ tool_name: "Bash", tool_input: { command: "rm" } }]
    },
    quota: { delta: 1_200_000, weeklyUsed: 14_400_000, weeklyLimit: 60_000_000, weekPercent: 24 }
  });
  assert.equal(
    footer,
    "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid quota=+1.2M week=24% denied=Bash(rm)"
  );
});

test("renderRunFooter omits quota= when delta is null but still shows week=", () => {
  const footer = renderRunFooter({
    model: "z-ai/glm-5.2",
    summary: BASE_SUMMARY,
    quota: { delta: null, weeklyUsed: 14_400_000, weeklyLimit: 60_000_000, weekPercent: 24 }
  });
  assert.equal(footer, "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid week=24%");
});

test("renderRunFooter omits a negative delta (weekly reset mid-run) but still shows week=", () => {
  const footer = renderRunFooter({
    model: "z-ai/glm-5.2",
    summary: BASE_SUMMARY,
    quota: { delta: -49_900_000, weeklyUsed: 100_000, weeklyLimit: 60_000_000, weekPercent: 0 }
  });
  assert.equal(footer, "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid week=0%");
});

test("renderRunFooter shows quota= without week= when weekPercent is not computable", () => {
  const footer = renderRunFooter({
    model: "z-ai/glm-5.2",
    summary: BASE_SUMMARY,
    quota: { delta: 1_200_000, weeklyUsed: null, weeklyLimit: null, weekPercent: null }
  });
  assert.equal(footer, "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid quota=+1.2M");
});

test("renderRunFooter omits both quota= and week= when quota is null", () => {
  const footer = renderRunFooter({ model: "z-ai/glm-5.2", summary: BASE_SUMMARY, quota: null });
  assert.equal(footer, "[nano] model=z-ai/glm-5.2 turns=3 tokens=1500in/200out secs=1 session=sid");
});

test("truncateInline returns text unchanged when within limit", () => {
  const out = truncateInline("short", { maxChars: 10 });
  assert.equal(out.text, "short");
  assert.equal(out.truncated, false);
});

test("truncateInline truncates with char count when no jobId", () => {
  const out = truncateInline("abcdefghij", { maxChars: 4 });
  assert.equal(out.text, "abcd\n\n… truncated (10 chars total)");
  assert.equal(out.truncated, true);
});

test("truncateInline truncates with jobId pointer when jobId given", () => {
  const out = truncateInline("abcdefghij", { maxChars: 4, jobId: "job-7" });
  assert.equal(out.text, "abcd\n\n… truncated, full output: /nano:result job-7");
  assert.equal(out.truncated, true);
});

test("truncateInline default maxChars is 8000", () => {
  const value = "L".repeat(8000);
  const within = truncateInline(value);
  assert.equal(within.truncated, false);
  const over = truncateInline(value + "X");
  assert.equal(over.truncated, true);
});

// ---------------------------------------------------------------------------
// runClaude integration against the fake binary
// ---------------------------------------------------------------------------

async function setupFakeClaude(behavior = "ok", options = {}) {
  const binDir = makeTempDir("runclaude-bin-");
  const dataDir = makeTempDir("runclaude-data-");
  const cwd = makeTempDir("runclaude-cwd-");
  const { scriptPath, invocationsLog } = installFakeClaude(binDir, behavior, options);
  // The fake binary must be found as `claude` on PATH.
  const target = path.join(binDir, "claude");
  if (scriptPath !== target) {
    fs.copyFileSync(scriptPath, target);
    fs.chmodSync(target, 0o755);
  }
  const env = buildEnv(binDir, dataDir);
  return { binDir, dataDir, cwd, scriptPath, invocationsLog, env };
}

test("runClaude json run: status 0, parseable stdout, noise filtered from stderr", async () => {
  const { cwd, invocationsLog, env } = await setupFakeClaude("ok");
  const args = buildClaudeArgs({ prompt: "hello world", model: "z-ai/glm-5.2", outputFormat: "json" });
  const result = await runClaude({ cwd, args, env });
  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(typeof result.pid, "number");
  const parsed = parseClaudeJsonOutput(result.stdout);
  assert.equal(parsed.type, "result");
  assert.equal(parsed.is_error, false);
  // The unrecognized_model noise line must be filtered out of stderr.
  assert.equal(result.stderr.includes("unrecognized_model"), false);
  assert.equal(result.stderr, "");
  // An invocation was recorded.
  assert.equal(readInvocations(invocationsLog).length, 1);
});

test("runClaude stream-json run: onStdoutLine called 6 times, last line is a result", async () => {
  const { cwd, env } = await setupFakeClaude("ok");
  const args = buildClaudeArgs({ prompt: "go", model: "z-ai/glm-5.2", outputFormat: "stream-json" });
  assert.ok(args.includes("--verbose"), "stream-json args must include --verbose");
  const lines = [];
  const result = await runClaude({ cwd, args, env, onStdoutLine: (line) => lines.push(line) });
  assert.equal(result.status, 0);
  assert.equal(lines.length, 6, `lines=${JSON.stringify(lines)}`);
  const lastEvent = parseStreamEvent(lines[lines.length - 1], { cwd });
  assert.equal(lastEvent.event.type, "result");
  assert.equal(lastEvent.result.type, "result");
});

test("runClaude with promptViaStdin: invocation log shows the stdin prompt", async () => {
  const { cwd, invocationsLog, env } = await setupFakeClaude("ok");
  const args = buildClaudeArgs({ prompt: "from stdin", model: "z-ai/glm-5.2", outputFormat: "json", promptViaStdin: true });
  // No "--" / prompt token should be present in the argv.
  assert.ok(!args.includes("--"));
  const result = await runClaude({ cwd, args, env, input: "from stdin" });
  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  const invs = readInvocations(invocationsLog);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].prompt, "from stdin");
});

test("runClaude calls onSpawn with the child (numeric pid)", async () => {
  const { cwd, env } = await setupFakeClaude("ok");
  const args = buildClaudeArgs({ prompt: "x", model: "z-ai/glm-5.2", outputFormat: "json" });
  let spawnedChild = null;
  const result = await runClaude({
    cwd,
    args,
    env,
    onSpawn: (child) => {
      spawnedChild = child;
    }
  });
  assert.equal(result.status, 0);
  assert.ok(spawnedChild, "onSpawn was not called");
  assert.equal(typeof spawnedChild.pid, "number");
  assert.ok(Number.isFinite(spawnedChild.pid));
});

test("runClaude: EPIPE from a child that exits before reading stdin does not crash the companion", async () => {
  // A child that exits immediately without ever reading stdin, combined with
  // an input large enough to exceed the OS pipe buffer, reliably triggers an
  // EPIPE `error` event on child.stdin while runClaude is still writing.
  // Without a no-op error handler on that stream, this would be an uncaught
  // exception; with it, runClaude must still resolve normally.
  const binDir = makeTempDir("runclaude-epipe-bin-");
  const cwd = makeTempDir("runclaude-epipe-cwd-");
  writeExecutable(path.join(binDir, "claude"), "#!/usr/bin/env node\nprocess.exit(1);\n");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  delete env.CLAUDE_PLUGIN_DATA;

  const args = buildClaudeArgs({
    prompt: "x".repeat(200000),
    model: "z-ai/glm-5.2",
    outputFormat: "json",
    promptViaStdin: true
  });
  const result = await runClaude({ cwd, args, env, input: "x".repeat(5 * 1024 * 1024) });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("runClaude rejects when claude cannot be found", async () => {
  const emptyDir = makeTempDir("runclaude-noclaude-");
  const cwd = makeTempDir("runclaude-cwd-noclaude-");
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: emptyDir };
  delete env.CLAUDE_PLUGIN_DATA;
  const args = buildClaudeArgs({ prompt: "x", model: "z-ai/glm-5.2", outputFormat: "json" });
  await assert.rejects(
    runClaude({ cwd, args, env }),
    /Could not start claude:/
  );
});

// --- no-tools salvage args, call tracker, error text ---------------------------

test("buildClaudeArgs noTools emits an empty --tools= and no --allowedTools", () => {
  const args = buildClaudeArgs({
    prompt: "wrap up",
    model: "z-ai/glm-5.2",
    noTools: true,
    resumeSessionId: "sid-9",
    maxTurns: 1,
    addDirs: ["/tmp/spill"]
  });
  assert.ok(args.includes("--tools="));
  assert.equal(args.some((arg) => arg.startsWith("--allowedTools")), false);
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "1"]);
  assert.ok(args.includes("--restricted") && args.includes("--strict-mcp-config"));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "dontAsk"]);
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "sid-9"]);
  assert.ok(args.includes("--add-dir=/tmp/spill"));
  assert.deepEqual(args.slice(-2), ["--", "wrap up"]);
  // The normal path is unchanged.
  const normal = buildClaudeArgs({ prompt: "p", model: "m" });
  assert.ok(normal.includes("--tools=Read,Glob,Grep"));
  assert.ok(normal.some((arg) => arg.startsWith("--allowedTools=")));
  // Tampered profiles are still rejected.
  assert.throws(() => buildClaudeArgs({ prompt: "p", model: "m", profile: "root" }), /Unknown permission profile/);
});

test("createCallTracker records one call per message id with boundary-relative latency", () => {
  let clock = 1000;
  const tracker = createCallTracker({ now: () => clock });
  const usage = (i, cr, cc, o) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: o });

  clock = 1300; // 300 ms after the spawn
  tracker.onEvent({ type: "system", subtype: "init" });
  tracker.onEvent({ type: "assistant", message: { id: "m1", usage: usage(5, 0, 7, 1) } });
  clock = 1350;
  tracker.onEvent({ type: "assistant", message: { id: "m1", usage: usage(5, 0, 7, 40) } });
  clock = 1400;
  tracker.onEvent({ type: "user", message: {} });
  clock = 2900; // 1500 ms after the tool result
  tracker.onEvent({ type: "assistant", message: { id: "m2", usage: usage(9, 100, 0, 12) } });
  tracker.onEvent({ type: "assistant", message: { content: [] } }); // no id: ignored
  tracker.onEvent(null);
  tracker.onEvent({ type: "result" });

  assert.deepEqual(tracker.calls(), [
    { ms: 300, in: 5, cache_read: 0, cache_creation: 7, out: 40 },
    { ms: 1500, in: 9, cache_read: 100, cache_creation: 0, out: 12 }
  ]);
});

test("createCallTracker.start() restarts the latency boundary", () => {
  let clock = 1000;
  const tracker = createCallTracker({ now: () => clock });
  clock = 6000; // a slow quota preflight before the spawn
  tracker.start();
  clock = 6200;
  tracker.onEvent({ type: "assistant", message: { id: "m1", usage: { output_tokens: 1 } } });
  assert.equal(tracker.calls()[0].ms, 200);
});

test("buildRunErrorText redacts before clipping", () => {
  const key = "nano-secret-key-0123456789";
  const stderr = `${"p".repeat(490)}${key}`;
  const text = buildRunErrorText({
    summary: null,
    exitStatus: 1,
    stderr,
    redact: (value) => String(value).split(key).join("[redacted]")
  });
  assert.equal(text.includes("nano-secret"), false);
  assert.ok(text.length <= 500);
});

test("createCallTracker defaults missing usage fields to 0", () => {
  const tracker = createCallTracker({ now: () => 5 });
  tracker.onEvent({ type: "assistant", message: { id: "x" } });
  tracker.onEvent({ type: "assistant", message: { id: "y", usage: { output_tokens: 3 } } });
  assert.deepEqual(tracker.calls(), [
    { ms: 0, in: 0, cache_read: 0, cache_creation: 0, out: 0 },
    { ms: 0, in: 0, cache_read: 0, cache_creation: 0, out: 3 }
  ]);
});

test("percentile uses nearest rank and ignores non-numbers", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5, null, "x", 15], 50), 5);
});

test("buildRunErrorText covers errors, missing results and success", () => {
  const base = { isError: true, text: "", subtype: "error_max_turns" };
  assert.equal(buildRunErrorText({ summary: { ...base, text: "API Error: boom" } }), "API Error: boom");
  assert.equal(buildRunErrorText({ summary: base, parsedErrors: ["Reached maximum number of turns (3)"] }), "Reached maximum number of turns (3)");
  assert.equal(buildRunErrorText({ summary: base }), "error_max_turns");
  assert.equal(buildRunErrorText({ summary: { isError: false, text: "fine" } }), null);
  assert.equal(
    buildRunErrorText({ summary: null, exitStatus: 1, stderr: "line1\n\nline2\nline3\nline4\nline5\nline6" }),
    "claude exited 1: line1\nline2\nline3\nline4\nline5"
  );
  assert.equal(buildRunErrorText({ summary: { ...base, text: "x".repeat(900) } }).length, 500);
});

test("buildPingLogEntry records usage, timing and the scrubbed error", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const ok = buildPingLogEntry({
    model: "m",
    cwd: "/r",
    ping: { ok: true, usage: { input_tokens: 9, output_tokens: 2 } },
    ms: 321,
    now
  });
  assert.equal(ok.kind, "ping");
  assert.equal(ok.is_error, false);
  assert.equal(ok.in, 9);
  assert.equal(ok.out, 2);
  assert.equal(ok.ms, 321);
  assert.equal(ok.error, null);
  const bad = buildPingLogEntry({ model: "m", cwd: "/r", ping: { ok: false, usage: null, detail: "HTTP 401: nope" }, ms: 5, now });
  assert.equal(bad.is_error, true);
  assert.equal(bad.error, "HTTP 401: nope");
  assert.equal(bad.in, 0);
});

test("buildRunLogEntry records the new run fields and call stats", () => {
  const entry = buildRunLogEntry({
    model: "m",
    cwd: "/r",
    task: "t".repeat(400),
    summary: {
      isError: true,
      numTurns: 16,
      usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      durationMs: 9,
      permissionDenials: [],
      sessionId: "s",
      subtype: "error_max_turns",
      terminalReason: "max_turns"
    },
    kind: "review",
    jobId: "review-1",
    exit: 1,
    error: "e".repeat(800),
    promptBytes: 12,
    spilledDiffBytes: 99,
    wallMs: 1234,
    maxTurns: 15,
    stopReason: "max_turns",
    salvaged: false,
    calls: [
      { ms: 100, in: 1, cache_read: 0, cache_creation: 0, out: 1 },
      { ms: 900, in: 1, cache_read: 0, cache_creation: 0, out: 1 },
      { ms: 300, in: 1, cache_read: 0, cache_creation: 0, out: 1 }
    ]
  });
  assert.equal(entry.task.length, 300);
  assert.equal(entry.error.length, 500);
  assert.equal(entry.cache_creation, 3);
  assert.equal(entry.subtype, "error_max_turns");
  assert.equal(entry.terminalReason, "max_turns");
  assert.equal(entry.stopReason, "max_turns");
  assert.equal(entry.spilledDiffBytes, 99);
  assert.equal(entry.callMsMax, 900);
  assert.equal(entry.callMsP50, 300);
});

test("call tracker takes final per-call usage from the session transcript", () => {
  // Real claude's stream-json assistant events carry message-start usage,
  // which NanoGPT reports as zero; the transcript has the final counts.
  const configDir = makeTempDir();
  const cwd = makeTempDir();
  const sessionId = "0b6f1c2d-aaaa-bbbb-cccc-1234567890ab";
  const slugDir = path.join(configDir, "projects", fs.realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(slugDir, { recursive: true });
  const transcript = path.join(slugDir, `${sessionId}.jsonl`);
  const usageA = { input_tokens: 32557, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 179 };
  const usageB = { input_tokens: 1996, cache_read_input_tokens: 32704, cache_creation_input_tokens: 0, output_tokens: 1278 };
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: "go" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_a", usage: usageA } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_a", usage: usageA } }),
      "not json",
      JSON.stringify({ type: "assistant", message: { id: "msg_b", usage: usageB } })
    ].join("\n") + "\n"
  );

  const env = { CLAUDE_CONFIG_DIR: configDir };
  assert.equal(resolveSessionTranscript(sessionId, { cwd, env }), transcript);
  assert.equal(resolveSessionTranscript("../../etc", { cwd, env }), null);
  assert.equal(resolveSessionTranscript("ffffffff-0000", { cwd, env }), null);

  let clock = 0;
  const tracker = createCallTracker({ now: () => clock });
  clock = 10;
  tracker.onEvent({ type: "assistant", message: { id: "msg_a", usage: { input_tokens: 0, output_tokens: 0 } } });
  tracker.onEvent({ type: "user" });
  clock = 25;
  tracker.onEvent({ type: "assistant", message: { id: "msg_b", usage: { input_tokens: 0, output_tokens: 0 } } });
  tracker.onEvent({ type: "assistant", message: { id: "msg_c", usage: { input_tokens: 7, output_tokens: 3 } } });
  tracker.applyUsage(readTranscriptUsage(transcript));

  assert.deepEqual(tracker.calls(), [
    { ms: 10, in: 32557, cache_read: 0, cache_creation: 0, out: 179 },
    { ms: 15, in: 1996, cache_read: 32704, cache_creation: 0, out: 1278 },
    // not in the transcript: keeps its stream values
    { ms: 15, in: 7, cache_read: 0, cache_creation: 0, out: 3 }
  ]);
  assert.equal(readTranscriptUsage(null).size, 0);
  assert.equal(readTranscriptUsage(path.join(configDir, "missing.jsonl")).size, 0);
});
