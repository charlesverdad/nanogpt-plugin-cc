import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeKimi, readInvocations } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "nano-companion.mjs");

// Import the real state helpers so seeded jobs land in the same isolated
// CLAUDE_PLUGIN_DATA-derived directory the companion uses.
const STATE_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const { upsertJob, writeJobFile, resolveJobLogFile } = await import(STATE_MODULE);

/**
 * Spins up an isolated runtime: a fresh temp git repo (workspace), a temp bin
 * dir with the fake `kimi`, and a temp CLAUDE_PLUGIN_DATA dir for state.
 */
function setupRuntime(behavior = "ok") {
  const binDir = makeTempDir("kimi-bin-");
  const dataDir = makeTempDir("kimi-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("kimi-repo-"));
  initGitRepo(repoDir);
  const { invocationsLog } = installFakeKimi(binDir, behavior);
  const env = buildEnv(binDir, dataDir);
  return { binDir, dataDir, repoDir, invocationsLog, env };
}

function runCompanion(rt, args, options = {}) {
  return run("node", [SCRIPT, ...args], {
    cwd: options.cwd ?? rt.repoDir,
    env: rt.env,
    input: options.input
  });
}

function commitInitial(repoDir) {
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n", "utf8");
  run("git", ["add", "."], { cwd: repoDir });
  run("git", ["commit", "-m", "initial"], { cwd: repoDir });
}

// --- setup -----------------------------------------------------------------

test("setup --json reports ready when fake kimi is installed and authenticated", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.kimi.available, true);
  assert.equal(payload.auth.loggedIn, true);
  // The stop-time review gate is off by default, so the only remaining next
  // step is the optional suggestion to enable it.
  assert.equal(payload.reviewGateEnabled, false);
  assert.deepEqual(payload.nextSteps, [
    "Optional: run `/nano:setup --enable-review-gate` to require a fresh review before stop."
  ]);
});

test("setup --json reports not ready when authentication is missing", () => {
  const rt = setupRuntime("auth-missing");
  const result = runCompanion(rt, ["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  // `kimi --version` still works, so the binary is considered available.
  assert.equal(payload.kimi.available, true);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.some((step) => /kimi login/.test(step)));
});

test("setup (human render) reports needs attention without kimi on PATH", () => {
  // No fake kimi installed AND the host PATH is stripped so a real kimi (if the
  // host happens to have one) cannot be discovered. The companion spawns
  // `kimi` by name, so with PATH=binDir only it resolves to nothing.
  const binDir = makeTempDir("kimi-empty-bin-");
  const dataDir = makeTempDir("kimi-data-");
  const env = {
    ...process.env,
    PATH: binDir,
    CLAUDE_PLUGIN_DATA: dataDir
  };
  delete env.NANO_COMPANION_SESSION_ID;
  // Invoke node via its absolute path since PATH no longer contains it.
  const result = run(process.execPath, [SCRIPT, "setup"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: needs attention/);
  assert.match(result.stdout, /Install Kimi CLI/);
});

// --- review ----------------------------------------------------------------

test("review --json renders fake kimi output for a working-tree diff", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  // Create an uncommitted change so the working-tree scope has content.
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 1;\n", "utf8");

  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.equal(payload.kimi.status, 0);
  assert.match(payload.kimi.stdout, /Fake Kimi assistant response/);
  assert.equal(payload.target.mode, "working-tree");

  // The companion forwarded a review prompt to the fake binary as `-p`.
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].prompt && invocations[0].prompt.length > 0);
  assert.ok(invocations[0].argv.includes("--quiet"));
  assert.ok(invocations[0].argv.includes("--yolo"));
});

test("review (human render) surfaces the assistant text", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const y = 2;\n", "utf8");

  const result = runCompanion(rt, ["review", "--scope", "working-tree"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# NanoGPT Review/);
  assert.match(result.stdout, /Fake Kimi assistant response/);
});

test("review exits non-zero and reports failure when the kimi run fails", () => {
  const rt = setupRuntime("failure");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const z = 3;\n", "utf8");

  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.kimi.status, 2);
  assert.match(payload.kimi.stderr, /simulated run error/);
});

// --- task ------------------------------------------------------------------

test("task runs and returns fake assistant output", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "Refactor the parser"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fake Kimi assistant response/);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].prompt, "Refactor the parser");
  assert.equal(invocations[0].continue, false);
  assert.equal(invocations[0].thinking, false);
  assert.equal(invocations[0].model, null);
});

test("task forwards --model, --thinking, and --continue to the kimi binary", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, [
    "task",
    "--model",
    "kimi-pro",
    "--thinking",
    "--continue",
    "Keep going"
  ]);

  assert.equal(result.status, 0, result.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  const inv = invocations[0];
  assert.equal(inv.model, "kimi-pro");
  assert.equal(inv.thinking, true);
  assert.equal(inv.continue, true);
  assert.equal(inv.prompt, "Keep going");
  // Verify ordering/flags directly in argv too.
  assert.ok(inv.argv.includes("--model"));
  assert.ok(inv.argv.includes("--thinking"));
  assert.ok(inv.argv.includes("--continue"));
});

test("task --json reports the run status and raw output", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "Do a thing"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 0);
  assert.match(payload.rawOutput, /Fake Kimi assistant response/);
});

test("task reads the prompt from piped stdin", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task"], { input: "Prompt via stdin\n" });

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].prompt, /Prompt via stdin/);
});

// --- status / result / cancel ----------------------------------------------

test("status and result work for a completed foreground task", () => {
  const rt = setupRuntime("ok");
  const taskResult = runCompanion(rt, ["task", "--json", "Summarize the repo"]);
  assert.equal(taskResult.status, 0, taskResult.stderr);

  // The job was recorded; the overall status report should list it as finished.
  const status = runCompanion(rt, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished, "expected a finished job");
  assert.equal(statusPayload.latestFinished.status, "completed");
  const jobId = statusPayload.latestFinished.id;

  // Single-job status by id.
  const single = runCompanion(rt, ["status", jobId, "--json"]);
  assert.equal(single.status, 0, single.stderr);
  const singlePayload = JSON.parse(single.stdout);
  assert.equal(singlePayload.job.id, jobId);
  assert.equal(singlePayload.job.status, "completed");

  // Result for that job returns the stored raw assistant output.
  const resultOut = runCompanion(rt, ["result", jobId, "--json"]);
  assert.equal(resultOut.status, 0, resultOut.stderr);
  const resultPayload = JSON.parse(resultOut.stdout);
  assert.equal(resultPayload.job.id, jobId);
  assert.match(resultPayload.storedJob.result.rawOutput, /Fake Kimi assistant response/);
});

test("cancel marks an active job as cancelled", () => {
  const rt = setupRuntime("ok");
  // Seed a "running" job directly into the isolated state so cancel is
  // deterministic (no reliance on detached background workers).
  const env = { CLAUDE_PLUGIN_DATA: rt.dataDir };
  const previousEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = rt.dataDir;
  try {
    const jobId = "task-seeded-1";
    const logFile = resolveJobLogFile(rt.repoDir, jobId);
    fs.writeFileSync(logFile, "", "utf8");
    const record = {
      id: jobId,
      kind: "task",
      kindLabel: "rescue",
      title: "Kimi Task",
      jobClass: "task",
      summary: "seeded running job",
      workspaceRoot: rt.repoDir,
      status: "running",
      phase: "running",
      pid: Number.NaN, // dead/invalid pid: terminateProcessTree is a no-op.
      logFile,
      startedAt: new Date().toISOString()
    };
    writeJobFile(rt.repoDir, jobId, record);
    upsertJob(rt.repoDir, record);

    const cancel = runCompanion(rt, ["cancel", jobId, "--json"]);
    assert.equal(cancel.status, 0, cancel.stderr);
    const cancelPayload = JSON.parse(cancel.stdout);
    assert.equal(cancelPayload.jobId, jobId);
    assert.equal(cancelPayload.status, "cancelled");

    // Confirm the persisted job is now cancelled.
    const status = runCompanion(rt, ["status", jobId, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.job.status, "cancelled");
  } finally {
    if (previousEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousEnv;
    }
    void env;
  }
});
