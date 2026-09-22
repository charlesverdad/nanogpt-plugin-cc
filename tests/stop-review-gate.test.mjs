import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeClaude, readInvocations } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const LIFECYCLE_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const STATE_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const { setConfig, getConfig } = await import(STATE_MODULE);

// Shadow the real macOS/Linux keychain lookups so a real NanoGPT key that
// might be configured on the machine running these tests can never leak in
// (see the matching helper/comment in tests/runtime.test.mjs).
function blockSystemKeychain(binDir) {
  const denyScript = "#!/usr/bin/env node\nprocess.exit(1);\n";
  writeExecutable(path.join(binDir, "security"), denyScript);
  writeExecutable(path.join(binDir, "secret-tool"), denyScript);
}

/**
 * Spins up an isolated runtime. When `installClaude` is false, the fake
 * `claude` is omitted AND the host PATH is stripped to just the empty bin
 * dir, so the companion cannot discover any real claude on the host.
 */
function setupRuntime({ behavior = "ok", installClaude = true, apiKey = true } = {}) {
  const binDir = makeTempDir("claude-bin-");
  const dataDir = makeTempDir("claude-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("claude-repo-"));
  initGitRepo(repoDir);
  if (installClaude) {
    installFakeClaude(binDir, behavior);
  }
  blockSystemKeychain(binDir);
  const env = buildEnv(binDir, dataDir, apiKey ? {} : { NANOGPT_API_KEY: undefined });
  if (!installClaude) {
    // Strip the inherited PATH so a host-installed claude cannot be resolved.
    env.PATH = binDir;
  }
  return { binDir, dataDir, repoDir, env };
}

/**
 * Run `fn` with `process.env.CLAUDE_PLUGIN_DATA` pointed at the runtime's data
 * dir, so in-process state helpers (setConfig/getConfig) resolve the SAME state
 * directory the spawned hook child uses (the child gets it via `rt.env`).
 */
function withRuntimeState(rt, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = rt.dataDir;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function enableGate(rt) {
  withRuntimeState(rt, () => setConfig(rt.repoDir, "stopReviewGate", true));
}

function runStopHook(rt, input, options = {}) {
  // Invoke node via its absolute path so tests that strip PATH (to hide
  // claude) can still launch the hook itself.
  return run(process.execPath, [STOP_HOOK], {
    cwd: options.cwd ?? rt.repoDir,
    env: rt.env,
    input: JSON.stringify(input ?? {})
  });
}

function runLifecycleHook(rt, eventName, input, options = {}) {
  return run(process.execPath, [LIFECYCLE_HOOK, eventName], {
    cwd: options.cwd ?? rt.repoDir,
    env: rt.env,
    input: JSON.stringify(input ?? {})
  });
}

// --- default-disabled behavior (the critical safety case) ------------------

test("Stop hook is a no-op by default (gate disabled): exits 0, no block decision", () => {
  const rt = setupRuntime();
  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "did some edits" });

  assert.equal(result.status, 0, result.stderr);
  // No JSON decision payload should be emitted on stdout when the gate is off.
  assert.equal(result.stdout.trim(), "");
});

test("Stop hook with a fresh (default) config does not trigger a review", () => {
  const rt = setupRuntime();
  // Confirm config is genuinely empty / gate-off before running.
  const config = withRuntimeState(rt, () => getConfig(rt.repoDir));
  assert.equal(Boolean(config.stopReviewGate), false);

  const result = runStopHook(rt, { cwd: rt.repoDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

// --- enabled gate, claude/key unavailable: graceful no-block ----------------

test("Stop hook with gate enabled but claude unavailable does not block", () => {
  const rt = setupRuntime({ installClaude: false });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  // No block decision: the gate degrades to a stderr setup note.
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /NanoGPT is not set up for the review gate/);
  assert.match(result.stderr, /\/nano:setup/);
});

test("Stop hook with gate enabled but no API key does not block", () => {
  const rt = setupRuntime({ apiKey: false });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /NanoGPT is not set up for the review gate/);
});

// --- enabled gate, claude available: review runs read-only and parses output ---

test("Stop hook with gate enabled blocks when the review returns a non-ALLOW answer", () => {
  // The fake claude prints a canned message that does not start with ALLOW:,
  // so the parser treats it as an unexpected answer and blocks.
  const rt = setupRuntime({ behavior: "ok" });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /unexpected answer/);
});

test("Stop hook runs the review task with the read-only tool profile", () => {
  const rt = setupRuntime({ behavior: "ok" });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });
  assert.equal(result.status, 0, result.stderr);

  const invocationsLog = path.join(rt.binDir, "claude-invocations.log");
  const invocations = readInvocations(invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tools, "Read,Glob,Grep");
  assert.equal(invocations[0].allowedTools, "Read,Glob,Grep");
});

test("Stop hook allows the session to stop when the review answers ALLOW", () => {
  const binDir = makeTempDir("claude-bin-");
  const dataDir = makeTempDir("claude-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("claude-repo-"));
  initGitRepo(repoDir);
  installFakeClaude(binDir, "ok", { resultText: "ALLOW: nothing to flag" });
  blockSystemKeychain(binDir);
  const rt = { binDir, dataDir, repoDir, env: buildEnv(binDir, dataDir) };
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

// --- session lifecycle hook -------------------------------------------------

test("session-lifecycle hook handles SessionStart without error", () => {
  const rt = setupRuntime();
  const result = runLifecycleHook(rt, "SessionStart", {
    session_id: "sess-123",
    cwd: rt.repoDir,
    hook_event_name: "SessionStart"
  });

  assert.equal(result.status, 0, result.stderr);
});

test("session-lifecycle hook writes the session id to CLAUDE_ENV_FILE on SessionStart", () => {
  const rt = setupRuntime();
  const envFile = path.join(rt.dataDir, "claude-env");
  const env = { ...rt.env, CLAUDE_ENV_FILE: envFile };

  const result = run(process.execPath, [LIFECYCLE_HOOK, "SessionStart"], {
    cwd: rt.repoDir,
    env,
    input: JSON.stringify({ session_id: "sess-xyz", cwd: rt.repoDir })
  });

  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(envFile, "utf8");
  assert.match(written, /NANO_COMPANION_SESSION_ID='sess-xyz'/);
});

test("session-lifecycle hook handles SessionEnd without error (no jobs)", () => {
  const rt = setupRuntime();
  const result = runLifecycleHook(rt, "SessionEnd", {
    session_id: "sess-123",
    cwd: rt.repoDir,
    hook_event_name: "SessionEnd"
  });

  assert.equal(result.status, 0, result.stderr);
});

test("session-lifecycle hook ignores unknown events", () => {
  const rt = setupRuntime();
  const result = runLifecycleHook(rt, "SomethingElse", { session_id: "sess-1", cwd: rt.repoDir });

  assert.equal(result.status, 0, result.stderr);
});
