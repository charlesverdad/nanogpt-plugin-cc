import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveApiKey,
  requireApiKey,
  resolveBaseUrl,
  buildChildEnv,
  normalizeBashAllow,
  buildPermissionProfile,
  buildClaudeArgs,
  parseClaudeVersion,
  compareVersions,
  DEFAULT_BASE_URL,
  KEY_SETUP_COMMAND,
  KEYCHAIN_SERVICE,
  STRIPPED_ENV_VARS,
  DEFAULT_BASH_ALLOW
} from "../plugins/nano/scripts/lib/runtime.mjs";

function fakeRunCommandImpl(over = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: over.status ?? 0,
      stdout: over.stdout ?? "FAKE-KEY-FROM-KEYCHAIN",
      stderr: over.stderr ?? "",
      error: over.error ?? null
    };
  };
  return { impl, calls };
}

function withEnv(pairs, fn) {
  const saved = {};
  for (const [name, value] of pairs) {
    saved[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of pairs) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

test("resolveApiKey: NANOGPT_API_KEY wins and is trimmed, runCommandImpl not called", () => {
  const { impl, calls } = fakeRunCommandImpl();
  const result = resolveApiKey({
    env: { NANOGPT_API_KEY: "  FAKE-ENV-KEY-123  " },
    platform: "darwin",
    runCommandImpl: impl
  });
  assert.equal(result.key, "FAKE-ENV-KEY-123");
  assert.equal(result.source, "NANOGPT_API_KEY environment variable");
  assert.equal(calls.length, 0);
});

test("resolveApiKey: empty NANOGPT_API_KEY falls through to platform lookup", () => {
  const { impl, calls } = fakeRunCommandImpl({ stdout: "FAKE-KEYCHAIN-KEY" });
  const result = resolveApiKey({
    env: { NANOGPT_API_KEY: "   " },
    platform: "darwin",
    runCommandImpl: impl
  });
  assert.equal(result.key, "FAKE-KEYCHAIN-KEY");
  assert.equal(calls.length, 1);
});

test('resolveApiKey: darwin calls security find-generic-password and returns trimmed stdout', () => {
  const { impl, calls } = fakeRunCommandImpl({ stdout: "  darwin-key-abc  " });
  const result = resolveApiKey({ env: {}, platform: "darwin", runCommandImpl: impl });
  assert.equal(result.key, "darwin-key-abc");
  assert.match(result.source, /macOS keychain/);
  assert.match(result.source, new RegExp(KEYCHAIN_SERVICE));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "security");
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
});

test("resolveApiKey: darwin with non-zero status returns null key/source", () => {
  const { impl, calls } = fakeRunCommandImpl({ status: 1, stdout: "whatever" });
  const result = resolveApiKey({ env: {}, platform: "darwin", runCommandImpl: impl });
  assert.deepEqual(result, { key: null, source: null });
  assert.equal(calls.length, 1);
});

test("resolveApiKey: darwin with empty stdout returns null key/source", () => {
  const { impl } = fakeRunCommandImpl({ status: 0, stdout: "   \n  " });
  const result = resolveApiKey({ env: {}, platform: "darwin", runCommandImpl: impl });
  assert.deepEqual(result, { key: null, source: null });
});

test('resolveApiKey: linux calls secret-tool lookup service nanogpt-api-key', () => {
  const { impl, calls } = fakeRunCommandImpl({ stdout: "linux-key-xyz" });
  const result = resolveApiKey({ env: {}, platform: "linux", runCommandImpl: impl });
  assert.equal(result.key, "linux-key-xyz");
  assert.match(result.source, /secret-tool/);
  assert.match(result.source, new RegExp(KEYCHAIN_SERVICE));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "secret-tool");
  assert.deepEqual(calls[0].args, ["lookup", "service", KEYCHAIN_SERVICE]);
});

test("resolveApiKey: win32 returns null without calling runCommandImpl", () => {
  const { impl, calls } = fakeRunCommandImpl();
  const result = resolveApiKey({ env: {}, platform: "win32", runCommandImpl: impl });
  assert.deepEqual(result, { key: null, source: null });
  assert.equal(calls.length, 0);
});

test("resolveApiKey: runCommandImpl that throws yields null", () => {
  const impl = () => {
    throw new Error("boom");
  };
  const result = resolveApiKey({ env: {}, platform: "darwin", runCommandImpl: impl });
  assert.deepEqual(result, { key: null, source: null });
});

test("resolveApiKey: source never contains the key value", () => {
  const cases = [
    { env: { NANOGPT_API_KEY: "SECRET-VALUE-AAA" }, platform: "darwin", stdout: "FAKE-KEYCHAIN" },
    { env: {}, platform: "darwin", stdout: "SECRET-VALUE-BBB" },
    { env: {}, platform: "linux", stdout: "SECRET-VALUE-CCC" }
  ];
  for (const c of cases) {
    const { impl } = fakeRunCommandImpl({ stdout: c.stdout });
    const result = resolveApiKey({ env: c.env, platform: c.platform, runCommandImpl: impl });
    if (result.source) {
      assert.equal(result.source.includes(result.key), false, `source leaked key: ${result.source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// requireApiKey
// ---------------------------------------------------------------------------

test("requireApiKey: throws when no key, message contains KEY_SETUP_COMMAND and not .env", () => {
  const { impl } = fakeRunCommandImpl({ status: 1, stdout: "" });
  assert.throws(
    () => requireApiKey({ env: {}, platform: "darwin", runCommandImpl: impl }),
    (err) => {
      assert.equal(err instanceof Error, true);
      assert.match(err.message, new RegExp(KEY_SETUP_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(err.message, /\.env/);
      return true;
    }
  );
});

test("requireApiKey: returns { key, source } when present", () => {
  const result = requireApiKey({ env: { NANOGPT_API_KEY: "FAKE-PRESENT-KEY" }, platform: "win32" });
  assert.equal(result.key, "FAKE-PRESENT-KEY");
  assert.equal(result.source, "NANOGPT_API_KEY environment variable");
});

// ---------------------------------------------------------------------------
// resolveBaseUrl
// ---------------------------------------------------------------------------

test("resolveBaseUrl: default is DEFAULT_BASE_URL", () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ NANOGPT_BASE_URL: "" }), DEFAULT_BASE_URL);
});

test("resolveBaseUrl: NANOGPT_BASE_URL overrides", () => {
  assert.equal(resolveBaseUrl({ NANOGPT_BASE_URL: "https://example.com/api" }), "https://example.com/api");
});

test("resolveBaseUrl: trailing slashes are stripped", () => {
  assert.equal(resolveBaseUrl({ NANOGPT_BASE_URL: "https://example.com/api/" }), "https://example.com/api");
  assert.equal(resolveBaseUrl({ NANOGPT_BASE_URL: "https://example.com/api///" }), "https://example.com/api");
});

test("resolveBaseUrl: whitespace-only falls back to default", () => {
  assert.equal(resolveBaseUrl({ NANOGPT_BASE_URL: "   " }), DEFAULT_BASE_URL);
});

test("resolveBaseUrl: does not mutate env", () => {
  const env = { NANOGPT_BASE_URL: "https://example.com/api/" };
  resolveBaseUrl(env);
  assert.equal(env.NANOGPT_BASE_URL, "https://example.com/api/");
});

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

test("buildChildEnv: removes every STRIPPED_ENV_VARS name", () => {
  const baseEnv = {};
  for (const name of STRIPPED_ENV_VARS) {
    baseEnv[name] = "should-be-removed";
  }
  baseEnv.PATH = "/usr/bin:/bin";
  const env = buildChildEnv({ baseEnv, apiKey: "K", model: "m", baseUrl: "https://x/api" });
  for (const name of STRIPPED_ENV_VARS) {
    assert.equal(name in env, false, `expected ${name} to be stripped`);
  }
  assert.equal(env.PATH, "/usr/bin:/bin");
});

test("buildChildEnv: sets all expected vars", () => {
  const env = buildChildEnv({ baseEnv: { PATH: "/bin" }, apiKey: "K", model: "glm-5.2", baseUrl: "https://x/api" });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://x/api");
  assert.equal(env.ANTHROPIC_API_KEY, "K");
  assert.equal(env.API_TIMEOUT_MS, "600000");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.2");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.2");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.2");
});

test("buildChildEnv: does not mutate baseEnv", () => {
  const baseEnv = { PATH: "/bin", ANTHROPIC_MODEL: "old" };
  const snapshot = { ...baseEnv };
  buildChildEnv({ baseEnv, apiKey: "K", model: "m", baseUrl: "https://x/api" });
  assert.deepEqual(baseEnv, snapshot);
});

test("buildChildEnv: explicit baseUrl wins over NANOGPT_BASE_URL", () => {
  const env = buildChildEnv({
    baseEnv: { NANOGPT_BASE_URL: "https://from-env/api" },
    apiKey: "K",
    model: "m",
    baseUrl: "https://explicit/api"
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://explicit/api");
});

test("buildChildEnv: falls back to NANOGPT_BASE_URL when baseUrl omitted", () => {
  const env = buildChildEnv({
    baseEnv: { NANOGPT_BASE_URL: "https://from-env/api" },
    apiKey: "K",
    model: "m"
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://from-env/api");
});

test("buildChildEnv: throws without apiKey", () => {
  assert.throws(() => buildChildEnv({ baseEnv: {}, model: "m" }), /API key/);
});

test("buildChildEnv: throws without model", () => {
  assert.throws(() => buildChildEnv({ baseEnv: {}, apiKey: "K" }), /model/);
});

// ---------------------------------------------------------------------------
// normalizeBashAllow
// ---------------------------------------------------------------------------

test("normalizeBashAllow: trims, collapses whitespace, drops empties, dedups preserving order", () => {
  assert.deepEqual(
    normalizeBashAllow(["  git   status ", "git status", "", "   ", "ls", "git log", "ls"]),
    ["git status", "ls", "git log"]
  );
});

test("normalizeBashAllow: [] returns []", () => {
  assert.deepEqual(normalizeBashAllow([]), []);
});

test("normalizeBashAllow: throws on parenthesis, comma, asterisk", () => {
  for (const bad of ["git (status)", "a,b", "rm -rf *"]) {
    assert.throws(() => normalizeBashAllow([bad]), /Invalid Bash allowlist prefix/);
  }
});

// BUG: runtime.mjs collapses internal whitespace (incl. \n and \r) into a
// single space BEFORE running the invalid-character check, so prefixes that
// contain a newline are silently normalized to "git status" instead of being
// rejected. The contract says newlines must throw. This test documents the
// correct behaviour and currently fails.
test("normalizeBashAllow: throws on newline (\\n, \\r)", () => {
  assert.throws(() => normalizeBashAllow(["git\nstatus"]), /Invalid Bash allowlist prefix/);
  assert.throws(() => normalizeBashAllow(["git\rstatus"]), /Invalid Bash allowlist prefix/);
});

// ---------------------------------------------------------------------------
// buildPermissionProfile
// ---------------------------------------------------------------------------

test('buildPermissionProfile: read gives tools and allowedTools exactly Read/Glob/Grep', () => {
  const p = buildPermissionProfile("read");
  assert.deepEqual(p.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(p.allowedTools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(p.bashAllow, []);
  assert.equal(p.name, "read");
  assert.equal(p.tools.includes("Bash"), false);
  assert.equal(p.tools.includes("Edit"), false);
  assert.equal(p.tools.includes("Write"), false);
  assert.equal(p.allowedTools.some((t) => t.includes("Bash")), false);
  assert.equal(p.allowedTools.some((t) => t.includes("Edit")), false);
});

test('buildPermissionProfile: write with default allowlist', () => {
  const p = buildPermissionProfile("write");
  assert.deepEqual(p.tools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
  assert.deepEqual(p.allowedTools, [
    "Read",
    "Glob",
    "Grep",
    "Edit(./**)",
    "Write(./**)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(ls:*)"
  ]);
  assert.deepEqual(p.bashAllow, [...DEFAULT_BASH_ALLOW]);
});

test('buildPermissionProfile: write with empty bashAllow drops Bash', () => {
  const p = buildPermissionProfile("write", { bashAllow: [] });
  assert.deepEqual(p.tools, ["Read", "Glob", "Grep", "Edit", "Write"]);
  assert.equal(p.tools.includes("Bash"), false);
  assert.equal(p.allowedTools.some((t) => t.startsWith("Bash")), false);
  assert.deepEqual(p.allowedTools, ["Read", "Glob", "Grep", "Edit(./**)", "Write(./**)"]);
});

test('buildPermissionProfile: custom bashAllow yields Bash(prefix:*)', () => {
  const p = buildPermissionProfile("write", { bashAllow: ["npm test"] });
  assert.deepEqual(p.tools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
  assert.equal(p.allowedTools.includes("Bash(npm test:*)"), true);
});

test("buildPermissionProfile: unknown profile throws", () => {
  assert.throws(() => buildPermissionProfile("admin"), /Unknown permission profile/);
});

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------

test("buildClaudeArgs: exact argv for read profile + json", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "z-ai/glm-5.2" });
  assert.deepEqual(args, [
    "-p",
    "--restricted",
    "--strict-mcp-config",
    "--model",
    "z-ai/glm-5.2",
    "--tools=Read,Glob,Grep",
    "--permission-mode",
    "dontAsk",
    "--allowedTools=Read,Glob,Grep",
    "--output-format",
    "json",
    "--",
    "hi"
  ]);
});

test("buildClaudeArgs: variadic flags only ever use --flag=value form", () => {
  for (const profile of ["read", "write"]) {
    const args = buildClaudeArgs({ prompt: "hi", model: "m", profile });
    assert.equal(args.includes("--tools"), false, "bare --tools present");
    assert.equal(args.includes("--allowedTools"), false, "bare --allowedTools present");
    assert.equal(args.some((a) => a.startsWith("--tools=")), true);
    assert.equal(args.some((a) => a.startsWith("--allowedTools=")), true);
  }
});

test("buildClaudeArgs: prompt is always last and immediately follows --", () => {
  const args = buildClaudeArgs({ prompt: "do thing", model: "m" });
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "do thing");
});

test('buildClaudeArgs: prompt starting with "-" still comes after --', () => {
  const args = buildClaudeArgs({ prompt: "--help me", model: "m" });
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "--help me");
});

test('buildClaudeArgs: stream-json adds --verbose', () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", outputFormat: "stream-json" });
  assert.equal(args.includes("--verbose"), true);
  // --verbose appears before --
  const verboseIdx = args.indexOf("--verbose");
  const dashIdx = args.indexOf("--");
  assert.ok(verboseIdx < dashIdx);
});

test("buildClaudeArgs: resumeSessionId adds --resume <id> before --", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", resumeSessionId: "sess-123" });
  const resumeIdx = args.indexOf("--resume");
  assert.equal(args[resumeIdx + 1], "sess-123");
  const dashIdx = args.indexOf("--");
  assert.ok(resumeIdx < dashIdx);
});

test("buildClaudeArgs: write profile tools/allowedTools strings", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", profile: "write" });
  assert.equal(args.some((a) => a === "--tools=Read,Glob,Grep,Edit,Write,Bash"), true);
  assert.equal(
    args.some((a) => a === "--allowedTools=Read,Glob,Grep,Edit(./**),Write(./**),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(ls:*)"),
    true
  );
});

test("buildClaudeArgs: promptViaStdin true omits both -- and prompt", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", promptViaStdin: true });
  assert.equal(args.includes("--"), false);
  assert.equal(args.includes("hi"), false);
});

test("buildClaudeArgs: accepts a profile object from buildPermissionProfile", () => {
  const profile = buildPermissionProfile("write", { bashAllow: ["npm test"] });
  const args = buildClaudeArgs({ prompt: "hi", model: "m", profile });
  assert.equal(args.some((a) => a === "--tools=Read,Glob,Grep,Edit,Write,Bash"), true);
  assert.equal(args.some((a) => a === "--allowedTools=Read,Glob,Grep,Edit(./**),Write(./**),Bash(npm test:*)"), true);
});

test("buildClaudeArgs: throws for missing model", () => {
  assert.throws(() => buildClaudeArgs({ prompt: "hi" }), /model/);
});

test("buildClaudeArgs: throws for empty prompt", () => {
  assert.throws(() => buildClaudeArgs({ prompt: "", model: "m" }), /prompt/);
});

test('buildClaudeArgs: throws for unsupported outputFormat "text"', () => {
  assert.throws(() => buildClaudeArgs({ prompt: "hi", model: "m", outputFormat: "text" }), /output format/);
});

// ---------------------------------------------------------------------------
// parseClaudeVersion
// ---------------------------------------------------------------------------

test('parseClaudeVersion: "2.1.278 (Claude Code)" === "2.1.278"', () => {
  assert.equal(parseClaudeVersion("2.1.278 (Claude Code)"), "2.1.278");
});

test("parseClaudeVersion: null for garbage", () => {
  assert.equal(parseClaudeVersion("no version here"), null);
  assert.equal(parseClaudeVersion(null), null);
  assert.equal(parseClaudeVersion(undefined), null);
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

test("compareVersions: 2.1.278 vs 2.1.1000", () => {
  assert.equal(compareVersions("2.1.278", "2.1.1000"), -1);
});

test("compareVersions: 2.2.0 vs 2.1.999", () => {
  assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
});

test("compareVersions: equal versions -> 0", () => {
  assert.equal(compareVersions("2.1.278", "2.1.278"), 0);
});
