import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeKimi } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const LIFECYCLE_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const STATE_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const { setConfig, getConfig } = await import(STATE_MODULE);

/**
 * Spins up an isolated runtime. When `installKimi` is false, the fake `kimi`
 * is omitted AND the host PATH is stripped to just the empty bin dir, so the
 * companion cannot discover any real kimi on the host.
 */
function setupRuntime({ behavior = "ok", installKimi = true } = {}) {
  const binDir = makeTempDir("kimi-bin-");
  const dataDir = makeTempDir("kimi-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("kimi-repo-"));
  initGitRepo(repoDir);
  if (installKimi) {
    installFakeKimi(binDir, behavior);
  }
  const env = buildEnv(binDir, dataDir);
  if (!installKimi) {
    // Strip the inherited PATH so a host-installed kimi cannot be resolved.
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
  // Invoke node via its absolute path so tests that strip PATH (to hide kimi)
  // can still launch the hook itself.
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

// --- enabled gate, kimi unavailable: graceful no-block ----------------------

test("Stop hook with gate enabled but kimi unavailable does not block", () => {
  const rt = setupRuntime({ installKimi: false });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  // No block decision: the gate degrades to a stderr setup note.
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Kimi is not set up for the review gate/);
  assert.match(result.stderr, /\/nano:setup/);
});

// --- enabled gate, kimi available: review runs and parses output ------------

test("Stop hook with gate enabled blocks when the review returns a non-ALLOW answer", () => {
  // The fake kimi prints a canned message that does not start with ALLOW:,
  // so the parser treats it as an unexpected answer and blocks.
  const rt = setupRuntime({ behavior: "ok" });
  enableGate(rt);

  const result = runStopHook(rt, { cwd: rt.repoDir, last_assistant_message: "edited a file" });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /unexpected answer/);
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
