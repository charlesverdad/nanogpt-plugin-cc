import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  updateState
} from "../plugins/nano/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: {},
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

// Runs `resolveStateDir` in a child process with TMPDIR pointed at a scratch
// dir and CLAUDE_PLUGIN_DATA unset, so the per-user fallback is exercised
// without touching the real temp dir.
function resolveFallbackStateDirIn(tmpRoot, workspace) {
  const stateModule = new URL("../plugins/nano/scripts/lib/state.mjs", import.meta.url).href;
  const env = { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot };
  delete env.CLAUDE_PLUGIN_DATA;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { resolveStateDir } = await import(${JSON.stringify(stateModule)}); console.log(resolveStateDir(${JSON.stringify(workspace)}));`
    ],
    { env, encoding: "utf8" }
  );
}

test("the CLAUDE_PLUGIN_DATA fallback is a per-user tmp dir kept at mode 0700", { skip: process.platform === "win32" }, () => {
  const tmpRoot = fs.realpathSync.native(makeTempDir("nano-fallback-"));
  const workspace = makeTempDir();
  const owner = String(process.getuid());
  const fallbackDir = path.join(tmpRoot, `nano-companion-${owner}`);
  // Pre-create it too permissive; the state module must tighten it.
  fs.mkdirSync(fallbackDir, { mode: 0o755 });
  fs.chmodSync(fallbackDir, 0o755);

  const result = resolveFallbackStateDirIn(tmpRoot, workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().startsWith(path.join(fallbackDir, "state")), true, result.stdout);
  assert.equal(fs.statSync(fallbackDir).mode & 0o777, 0o700);
});

test("the CLAUDE_PLUGIN_DATA fallback refuses a symlinked (possibly foreign) dir", { skip: process.platform === "win32" }, () => {
  const tmpRoot = fs.realpathSync.native(makeTempDir("nano-fallback-"));
  const workspace = makeTempDir();
  const elsewhere = makeTempDir("nano-elsewhere-");
  fs.symlinkSync(elsewhere, path.join(tmpRoot, `nano-companion-${process.getuid()}`));

  const result = resolveFallbackStateDirIn(tmpRoot, workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to use .*not a directory owned by the current user/);
});

// --- cross-process locking ---------------------------------------------------

/**
 * Runs `iterations` sequential `setConfig(workspace, "k<procIndex>_<i>", i)`
 * calls inside a freshly spawned node process, so the writes genuinely race
 * against the other spawned processes at the OS level (not just interleaved
 * async work inside one process). Returns a promise that resolves with the
 * child's exit code/stderr once it exits.
 */
function spawnConfigWriter({ stateModuleHref, workspace, dataDir, procIndex, iterations }) {
  const script = `
    const { setConfig } = await import(${JSON.stringify(stateModuleHref)});
    for (let i = 0; i < ${iterations}; i += 1) {
      setConfig(${JSON.stringify(workspace)}, ${JSON.stringify(`k${procIndex}_`)} + i, i);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("updateState's cross-process lock keeps 4 concurrent writers from losing each other's config keys", async () => {
  const stateModuleHref = new URL("../plugins/nano/scripts/lib/state.mjs", import.meta.url).href;
  const workspace = makeTempDir();
  const dataDir = makeTempDir("nano-lock-data-");
  const PROCESS_COUNT = 4;
  const ITERATIONS_PER_PROCESS = 25;

  const results = await Promise.all(
    Array.from({ length: PROCESS_COUNT }, (_, procIndex) =>
      spawnConfigWriter({ stateModuleHref, workspace, dataDir, procIndex, iterations: ITERATIONS_PER_PROCESS })
    )
  );

  for (const result of results) {
    assert.equal(result.code, 0, `writer process failed: ${result.stderr}`);
  }

  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  let config;
  try {
    // The state file must always be whole JSON, never a torn/partial write
    // left behind by a racing writer - readFileSync+JSON.parse below (inside
    // getConfig -> loadState) throws if it isn't.
    config = getConfig(workspace);
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }

  const expectedKeys = [];
  for (let procIndex = 0; procIndex < PROCESS_COUNT; procIndex += 1) {
    for (let i = 0; i < ITERATIONS_PER_PROCESS; i += 1) {
      expectedKeys.push(`k${procIndex}_${i}`);
    }
  }

  for (const key of expectedKeys) {
    const [, procIndexStr, iStr] = key.match(/^k(\d+)_(\d+)$/);
    assert.equal(config[key], Number(iStr), `missing or wrong value for ${key} (proc ${procIndexStr})`);
  }
  assert.equal(Object.keys(config).length, expectedKeys.length, "expected exactly one hundred config keys, none lost");
});

test("updateState throws once a fresh (actively held) lock outlasts the timeout", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lockDir = `${stateFile}.lock`;
  fs.mkdirSync(lockDir);

  const previousTimeout = process.env.NANO_STATE_LOCK_TIMEOUT_MS;
  process.env.NANO_STATE_LOCK_TIMEOUT_MS = "250";
  try {
    const startedAt = Date.now();
    assert.throws(
      () => updateState(workspace, (state) => {
        state.config.shouldNeverBeWritten = true;
      }),
      /Timed out.*state lock/
    );
    const elapsedMs = Date.now() - startedAt;
    // Should honor the short env override, not the 5s default.
    assert.ok(elapsedMs >= 200, `expected updateState to wait out the ~250ms timeout, only waited ${elapsedMs}ms`);
    assert.ok(elapsedMs < 4000, `expected the env-shortened timeout to be honored, waited ${elapsedMs}ms`);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.NANO_STATE_LOCK_TIMEOUT_MS;
    } else {
      process.env.NANO_STATE_LOCK_TIMEOUT_MS = previousTimeout;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  // The lock was never released by updateState (it threw before acquiring
  // it), so the pre-created lock dir is still exactly what we left it as.
  assert.equal(fs.existsSync(lockDir), false, "test cleanup should have removed the lock dir it pre-created");
});

test("updateState breaks a stale lock (old mtime) instead of waiting it out", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lockDir = `${stateFile}.lock`;
  fs.mkdirSync(lockDir);
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, staleTime, staleTime);

  const startedAt = Date.now();
  setConfig(workspace, "afterStaleLock", "unblocked");
  const elapsedMs = Date.now() - startedAt;

  assert.equal(getConfig(workspace).afterStaleLock, "unblocked");
  // Breaking a stale lock should be near-instant, not a multi-second wait.
  assert.ok(elapsedMs < 2000, `expected the stale lock to be broken quickly, took ${elapsedMs}ms`);
  // updateState released its own (new) lock when it finished.
  assert.equal(fs.existsSync(lockDir), false);
});
