import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/nano/scripts/lib/state.mjs";

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
