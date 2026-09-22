import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeTempDir, run } from "./helpers.mjs";
import {
  installFakeClaude,
  buildEnv,
  readInvocations,
  FAKE_API_KEY
} from "./fake-claude-fixture.mjs";

function sh(scriptPath, args, opts = {}) {
  return run(process.execPath, [scriptPath, ...args], opts);
}

test("fake claude --version", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir);
  const res = sh(scriptPath, ["--version"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^2\.1\.278 \(Claude Code\)\n$/);
});

test("fake claude --help contains required option tokens", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir);
  const res = sh(scriptPath, ["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--strict-mcp-config/);
  assert.match(res.stdout, /dontAsk/);
  assert.match(res.stdout, /-p, --print/);
  assert.match(res.stdout, /--output-format <format>/);
  assert.match(res.stdout, /-v, --version/);
});

test("ok json run returns parseable result and logs invocation", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const dataDir = makeTempDir("fake-claude-data-");
  const { scriptPath, invocationsLog } = installFakeClaude(binDir);
  const env = buildEnv(binDir, dataDir);
  const res = sh(
    scriptPath,
    ["-p", "--model", "m", "--tools=Read", "--allowedTools=Read", "--output-format", "json", "--", "hello"],
    { env }
  );
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.is_error, false);
  assert.equal(parsed.type, "result");

  const invs = readInvocations(invocationsLog);
  assert.equal(invs.length, 1);
  const inv = invs[0];
  assert.equal(inv.tools, "Read");
  assert.equal(inv.prompt, "hello");
  assert.equal(inv.model, "m");
  assert.equal(inv.allowedTools, "Read");
  assert.equal(inv.outputFormat, "json");

  // ANTHROPIC_API_KEY is not set by buildEnv, so it must not match the fake.
  assert.equal(inv.apiKeyMatchesFake, false);
  // The raw log file must never contain the fake API key.
  const raw = fs.readFileSync(invocationsLog, "utf8");
  assert.equal(raw.includes(FAKE_API_KEY), false, "log must not leak FAKE_API_KEY");
});

test("ok run with ANTHROPIC_API_KEY=FAKE_API_KEY sets apiKeyMatchesFake and still does not leak", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const dataDir = makeTempDir("fake-claude-data-");
  const { scriptPath, invocationsLog } = installFakeClaude(binDir);
  const env = buildEnv(binDir, dataDir, { ANTHROPIC_API_KEY: FAKE_API_KEY });
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "json", "--", "prompt here"],
    { env }
  );
  assert.equal(res.status, 0);
  const invs = readInvocations(invocationsLog);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].apiKeyMatchesFake, true);
  const raw = fs.readFileSync(invocationsLog, "utf8");
  assert.equal(raw.includes(FAKE_API_KEY), false, "log must not leak FAKE_API_KEY even when set");
});

test("stream-json without --verbose fails", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath, invocationsLog } = installFakeClaude(binDir);
  const env = buildEnv(binDir);
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "stream-json", "--", "x"],
    { env }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /stream-json requires --verbose/);
  // No invocation should have been recorded (we exit before recording).
  assert.equal(readInvocations(invocationsLog).length, 0);
});

test("stream-json with --verbose emits 5 JSON lines ending with type result", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir);
  const env = buildEnv(binDir);
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "stream-json", "--verbose", "--", "go"],
    { env }
  );
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const lines = res.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.equal(lines[0].type, "system");
  assert.equal(lines[0].subtype, "init");
  assert.equal(lines[1].type, "assistant");
  assert.equal(lines[2].type, "user");
  assert.equal(lines[3].type, "assistant");
  assert.equal(lines[4].type, "result");
  assert.equal(lines[4].is_error, false);
});

test("prompt is read from stdin when no -- is given", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath, invocationsLog } = installFakeClaude(binDir);
  const env = buildEnv(binDir);
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "json"],
    { env, input: "stdin-prompt-content" }
  );
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const invs = readInvocations(invocationsLog);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].prompt, "stdin-prompt-content");
});

test("denials behavior has 2 permission_denials", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir, "denials");
  const env = buildEnv(binDir);
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "json", "--", "do it"],
    { env }
  );
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.is_error, false);
  assert.equal(parsed.permission_denials.length, 2);
  assert.equal(parsed.permission_denials[0].tool_name, "Bash");
  assert.equal(parsed.permission_denials[1].tool_name, "Write");
});

test("no-json behavior exits 1 and prints non-json", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir, "no-json");
  const env = buildEnv(binDir);
  const res = sh(
    scriptPath,
    ["-p", "--output-format", "json", "--", "x"],
    { env }
  );
  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), "this is not json");
});

test("unsupported invocation exits 2", () => {
  const binDir = makeTempDir("fake-claude-test-");
  const { scriptPath } = installFakeClaude(binDir);
  const env = buildEnv(binDir);
  const res = sh(scriptPath, ["something-else"], { env });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unsupported invocation/);
});
