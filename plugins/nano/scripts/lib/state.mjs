import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWriteFileSync } from "./fs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// updateState() (and everything built on it: upsertJob, setConfig) is the
// only path allowed to read-modify-write state.json: it takes an
// inter-process lock so the foreground CLI, a detached background worker and
// `status`/`cancel` running concurrently can't clobber each other's writes.
// loadState/listJobs/getConfig stay lock-free: atomicWriteFileSync's
// rename-over-target means a reader always sees a whole file, never a torn
// one, so there is nothing for the lock to protect on the read side.
const STATE_LOCK_TIMEOUT_ENV = "NANO_STATE_LOCK_TIMEOUT_MS";
const DEFAULT_STATE_LOCK_TIMEOUT_MS = 5000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_RETRY_MIN_MS = 10;
const STATE_LOCK_RETRY_MAX_MS = 25;

function nowIso() {
  return new Date().toISOString();
}

function currentUserTag() {
  if (typeof process.getuid === "function") {
    return String(process.getuid());
  }
  try {
    return os.userInfo().username.replace(/[^a-zA-Z0-9._-]+/g, "-") || "user";
  } catch {
    return "user";
  }
}

/**
 * Per-user data dir used when CLAUDE_PLUGIN_DATA is unset. os.tmpdir() is
 * shared between users on Linux, so the name carries the uid and the dir is
 * kept private (see ensurePrivateDir).
 */
export function resolveFallbackDataDir() {
  return path.join(os.tmpdir(), `nano-companion-${currentUserTag()}`);
}

/**
 * Create `dir` with mode 0o700 if needed and refuse to use it unless it is a
 * real directory owned by the current user, so another local user cannot
 * pre-create it to read or plant job, config or cache files.
 */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
    throw new Error(`Refusing to use ${dir}: it is not a directory owned by the current user. Remove it or set CLAUDE_PLUGIN_DATA.`);
  }
  if (uid !== null && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : path.join(ensurePrivateDir(resolveFallbackDataDir()), "state");
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

function resolveStateLockTimeoutMs() {
  const raw = process.env[STATE_LOCK_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STATE_LOCK_TIMEOUT_MS;
}

function resolveStateLockDir(cwd) {
  return `${resolveStateFile(cwd)}.lock`;
}

/**
 * Synchronous sleep for the lock's retry loop. `updateState` is called from
 * synchronous code paths all over the CLI (including inside `mutate`
 * callbacks that must not become async), so this blocks the event loop for
 * `ms` via Atomics.wait rather than returning a Promise.
 */
function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function randomRetryDelayMs() {
  return STATE_LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (STATE_LOCK_RETRY_MAX_MS - STATE_LOCK_RETRY_MIN_MS + 1));
}

/** Removes `lockDir` if it is older than STATE_LOCK_STALE_MS. Returns whether it broke a lock. */
function breakStaleLock(lockDir) {
  let stat;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    // Already gone (released by its owner, or raced away by another waiter).
    return false;
  }
  if (Date.now() - stat.mtimeMs < STATE_LOCK_STALE_MS) {
    return false;
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires the cross-process lock that guards state.json's
 * load-mutate-save cycle. `fs.mkdirSync` on a not-yet-existing path is
 * atomic (only one caller ever wins EEXIST across processes), so an empty
 * directory next to state.json doubles as the lock. Retries with a
 * synchronous sleep until `timeoutMs` elapses, breaking any lock whose mtime
 * is older than STATE_LOCK_STALE_MS (its owner almost certainly crashed or
 * was killed while holding it).
 */
function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockDir = resolveStateLockDir(cwd);
  const timeoutMs = resolveStateLockTimeoutMs();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return lockDir;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    if (breakStaleLock(lockDir)) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the nano-companion state lock at ${lockDir}. ` +
          "Another nano-companion process may be stuck; delete that directory if it is not."
      );
    }

    sleepSync(Math.min(randomRetryDelayMs(), Math.max(0, deadline - Date.now())));
  }
}

function releaseStateLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort: a stale/missing lock dir is handled by breakStaleLock.
  }
}

/**
 * The only supported way to read-modify-write state.json. Holds the
 * cross-process lock for the whole load-mutate-save cycle (saveState's
 * pruned-job file/log cleanup included) so two processes racing to update
 * jobs or config can never produce a lost update. `mutate` must be
 * synchronous and must not itself call updateState/upsertJob/setConfig -
 * the lock is not re-entrant.
 */
export function updateState(cwd, mutate) {
  const lockDir = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  } finally {
    releaseStateLock(lockDir);
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
