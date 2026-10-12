import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, FAKE_API_KEY, installFakeClaude, readInvocations } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

import { DEFAULT_BASH_ALLOW, KEY_SETUP_COMMAND } from "../plugins/nano/scripts/lib/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "nano-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

// Import the real state helpers so seeded jobs/config land in the same
// isolated CLAUDE_PLUGIN_DATA-derived directory the companion uses.
const STATE_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const { listJobs, setConfig, upsertJob, writeJobFile, resolveJobFile, resolveJobLogFile } = await import(STATE_MODULE);

/**
 * Shadow the real `security` (macOS) / `secret-tool` (Linux) binaries with
 * ones that always fail, so resolveApiKey's keychain fallback never picks up
 * a real NanoGPT key that might happen to be configured on the machine
 * running these tests. Only needed for tests that deliberately unset
 * NANOGPT_API_KEY; every other test sets it via buildEnv, which is checked
 * first and never falls through to the keychain.
 */
function blockSystemKeychain(binDir) {
  const denyScript = "#!/usr/bin/env node\nprocess.exit(1);\n";
  writeExecutable(path.join(binDir, "security"), denyScript);
  writeExecutable(path.join(binDir, "secret-tool"), denyScript);
}

function walkFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Spins up an isolated runtime: a fresh temp git repo (workspace), a temp bin
 * dir with the fake `claude`, and a temp CLAUDE_PLUGIN_DATA dir for state.
 */
function setupRuntime(behavior = "ok", options = {}) {
  const binDir = makeTempDir("claude-bin-");
  const dataDir = makeTempDir("claude-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("claude-repo-"));
  initGitRepo(repoDir);
  const { invocationsLog } = installFakeClaude(binDir, behavior, options);
  const env = buildEnv(binDir, dataDir);
  return { binDir, dataDir, repoDir, invocationsLog, env };
}

function runCompanion(rt, args, options = {}) {
  return run("node", [SCRIPT, ...args], {
    cwd: options.cwd ?? rt.repoDir,
    env: options.env ?? rt.env,
    input: options.input
  });
}

function withPluginData(dataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function commitInitial(repoDir) {
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n", "utf8");
  run("git", ["add", "."], { cwd: repoDir });
  run("git", ["commit", "-m", "initial"], { cwd: repoDir });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `fn` every 100ms until it returns a truthy value, failing the test
 * after `timeoutMs`. Background workers are detached processes, so their
 * observable side effects (job files, invocation log) arrive asynchronously.
 */
async function waitFor(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      assert.fail(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(100);
  }
}

function isProcessGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// --- setup -----------------------------------------------------------------

test("setup --json reports ready when claude is available and the API key resolves", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false, "ready should be false without a reachable ping/subscription");
  assert.equal(payload.defaultModel, "z-ai/glm-5.2");
  assert.equal(payload.catalogSource, "builtin");
  assert.equal(payload.reviewGateEnabled, false);
  // checks have the new { id, label, ok, detail } shape
  const ids = payload.checks.map((c) => c.id);
  assert.deepEqual(ids, ["node", "claude", "contract", "apiKey", "ping", "subscription"]);
  const apiKeyCheck = payload.checks.find((c) => c.id === "apiKey");
  assert.equal(apiKeyCheck.ok, true);
  assert.match(apiKeyCheck.detail, /NANOGPT_API_KEY/);
  // ping/subscription fail against the unreachable test base url
  const pingCheck = payload.checks.find((c) => c.id === "ping");
  assert.equal(pingCheck.ok, false);
  const subCheck = payload.checks.find((c) => c.id === "subscription");
  assert.equal(subCheck.ok, false);
});

test("setup --json reports not ready and the keychain command when the API key is missing", () => {
  const rt = setupRuntime("ok");
  blockSystemKeychain(rt.binDir);
  const env = buildEnv(rt.binDir, rt.dataDir, { NANOGPT_API_KEY: undefined });

  const result = runCompanion(rt, ["setup", "--json"], { env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  const apiKeyCheck = payload.checks.find((c) => c.id === "apiKey");
  assert.equal(apiKeyCheck.ok, false);
  assert.equal(apiKeyCheck.detail, "not found");
  const pingCheck = payload.checks.find((c) => c.id === "ping");
  assert.equal(pingCheck.detail, "skipped: no API key");
  const subCheck = payload.checks.find((c) => c.id === "subscription");
  assert.equal(subCheck.detail, "skipped: no API key");
  const keyStep = payload.nextSteps.find((s) => s.startsWith(KEY_SETUP_COMMAND));
  assert.ok(keyStep, "nextSteps contains the keychain command");
  assert.equal(payload.nextSteps.some((s) => s.includes(".env")), false);
});

test("setup (human render) reports needs attention without claude on PATH", () => {
  // No fake claude installed AND the host PATH is stripped so a real claude
  // (if the host happens to have one) cannot be discovered.
  const binDir = makeTempDir("claude-empty-bin-");
  const dataDir = makeTempDir("claude-data-");
  blockSystemKeychain(binDir);
  const env = {
    ...process.env,
    PATH: binDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    NANOGPT_API_KEY: FAKE_API_KEY
  };
  delete env.NANO_COMPANION_SESSION_ID;
  const result = run(process.execPath, [SCRIPT, "setup"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: needs attention/);
  assert.match(result.stdout, /- \[!!\] Claude Code:/);
});

// --- review ------------------------------------------------------------------

test("review --json runs the read profile only and renders the fake result", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 1;\n", "utf8");

  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.equal(payload.target.mode, "working-tree");
  assert.match(payload.text, /Fake NanoGPT result\./);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tools, "Read,Glob,Grep");
  assert.equal(invocations[0].allowedTools, "Read,Glob,Grep");
  assert.ok(invocations[0].prompt && invocations[0].prompt.length > 0);
});

test("adversarial-review --json runs the read profile only", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const y = 2;\n", "utf8");

  const result = runCompanion(rt, ["adversarial-review", "--json", "--scope", "working-tree", "check auth boundaries"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Adversarial Review");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tools, "Read,Glob,Grep");
  assert.equal(invocations[0].allowedTools, "Read,Glob,Grep");
});

test("review (human render) shows the NanoGPT Review header, target, and footer", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const z = 3;\n", "utf8");

  const result = runCompanion(rt, ["review", "--scope", "working-tree"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# NanoGPT Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Fake NanoGPT result\./);
  assert.match(result.stdout, /\[nano\] model=/);
});

test("review exits non-zero and prefixes the failed body when the run fails", () => {
  const rt = setupRuntime("failure");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const w = 4;\n", "utf8");

  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.isError, true);
  assert.match(payload.text, /API Error: simulated failure/);
});

// --- review: no result / spill / binary / lockfile / --exclude (A1, A3) ----

test("review surfaces claude's stderr instead of crashing when claude returns no result", () => {
  const rt = setupRuntime("no-result-error");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 1;\n", "utf8");

  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("Cannot read properties"), false, "must not crash on a null summary");
  assert.equal(result.stderr.includes("Cannot read properties"), false, "must not crash on a null summary");
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /claude exited with status 1 before returning a result/);
  assert.match(payload.error, /piped stdin input exceeds 10MB/);
  // The noise line is filtered out of the surfaced stderr.
  assert.equal(result.stdout.includes("unrecognized_model"), false);
});

test("adversarial-review surfaces claude's stderr instead of crashing when claude returns no result", () => {
  const rt = setupRuntime("no-result-error");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 1;\n", "utf8");

  const result = runCompanion(rt, ["adversarial-review", "--json", "--scope", "working-tree", "check auth"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("Cannot read properties"), false, "must not crash on a null summary");
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /piped stdin input exceeds 10MB/);
});

test("a review diff larger than the inline budget is spilled to a file and claude gets --add-dir", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  run("git", ["checkout", "-b", "feature/spill"], { cwd: rt.repoDir });
  fs.writeFileSync(path.join(rt.repoDir, "big.txt"), `${"x".repeat(500_000)}\n`, "utf8");
  run("git", ["add", "."], { cwd: rt.repoDir });
  run("git", ["commit", "-m", "big"], { cwd: rt.repoDir });

  const env = { ...rt.env, NANO_REVIEW_INLINE_BYTES: "2000" };
  const result = runCompanion(rt, ["review", "--json", "--base", "main"], { env });

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  // The prompt points at the spill file instead of inlining the diff body.
  assert.match(invocations[0].prompt, /too large to inline/);
  assert.match(invocations[0].prompt, /nano-review-/);
  assert.equal(
    invocations[0].prompt.includes("x".repeat(100)),
    false,
    "the diff body must not be inlined"
  );
  // claude is granted Read access to the spill directory under --restricted.
  assert.ok(invocations[0].addDirs.length >= 1, "expected at least one --add-dir");
  assert.match(invocations[0].addDirs[0], /nano-review-/);
  // The spill directory is cleaned up after the run.
  assert.equal(fs.existsSync(invocations[0].addDirs[0]), false, "spill dir should be gone");
});

test("a committed binary file diffs as 'Binary files ... differ' with no base85 GIT binary patch", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  run("git", ["checkout", "-b", "feature/png"], { cwd: rt.repoDir });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 0)]);
  fs.writeFileSync(path.join(rt.repoDir, "snapshot.png"), png);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const b = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: rt.repoDir });
  run("git", ["commit", "-m", "add png"], { cwd: rt.repoDir });

  const result = runCompanion(rt, ["review", "--json", "--base", "main"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.match(invocations[0].prompt, /Binary files \S* and b\/snapshot\.png differ/);
  assert.equal(invocations[0].prompt.includes("GIT binary patch"), false, "no base85 payload");
});

test("a lockfile change is omitted from the inline review diff but listed in Diff Stat and the Omitted line", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  run("git", ["checkout", "-b", "feature/lock"], { cwd: rt.repoDir });
  fs.writeFileSync(path.join(rt.repoDir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n".repeat(40));
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const l = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: rt.repoDir });
  run("git", ["commit", "-m", "lockfile"], { cwd: rt.repoDir });

  const result = runCompanion(rt, ["review", "--json", "--base", "main"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(
    invocations[0].prompt.includes("lockfileVersion: 9.0"),
    false,
    "lockfile body must not be inlined"
  );
  assert.match(invocations[0].prompt, /pnpm-lock\.yaml/);
  assert.match(invocations[0].prompt, /Omitted from the inline diff: 1 file\(s\)/);
});

test("review --exclude excludes matching files from the inline diff", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  run("git", ["checkout", "-b", "feature/docs"], { cwd: rt.repoDir });
  fs.mkdirSync(path.join(rt.repoDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rt.repoDir, "docs", "keep.md"), "KEEP_ME\n", "utf8");
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const e = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: rt.repoDir });
  run("git", ["commit", "-m", "docs"], { cwd: rt.repoDir });

  const result = runCompanion(rt, ["review", "--json", "--base", "main", "--exclude", "docs/**"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations[0].prompt.includes("KEEP_ME"), false, "docs/** must exclude docs/keep.md");
  assert.match(invocations[0].prompt, /\+export const e = 1;/);
  assert.match(invocations[0].prompt, /Omitted from the inline diff: 1 file\(s\)[^\n]*docs\/keep\.md/);
});

// --- task: permission profiles ----------------------------------------------

test("task with no flags runs the write profile with the default Bash allowlist", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "Refactor the parser"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tools, "Read,Glob,Grep,Edit,Write,Bash");
  assert.match(invocations[0].allowedTools, /Edit\(\.\/\*\*\)/);
  assert.match(invocations[0].allowedTools, /Bash\(git status:\*\)/);
  // git diff/log/show take --output=<file>, which writes anywhere: not default.
  assert.doesNotMatch(invocations[0].allowedTools, /Bash\(git (diff|log|show):\*\)/);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.profile, "write");
  assert.deepEqual(payload.bashAllow, [...DEFAULT_BASH_ALLOW]);
});

test("--read-only runs the read profile with no Bash/Edit/Write", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--read-only", "Inspect only"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.profile, "read");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations[0].tools, "Read,Glob,Grep");
  assert.equal(invocations[0].allowedTools, "Read,Glob,Grep");
});

test("--allow-bash extends the write profile's Bash allowlist", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--allow-bash", "npm test", "Run the tests"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.match(invocations[0].allowedTools, /Bash\(npm test:\*\)/);
  assert.match(invocations[0].allowedTools, /Bash\(git status:\*\)/);
});

test("--read-only combined with --allow-bash is an error that points at the alternatives", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--read-only", "--allow-bash", "npm test", "Do a thing"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--read-only.*--allow-bash/s);
  assert.match(result.stderr, /runs have no Bash/);
  assert.match(result.stderr, /review`\/`adversarial-review --base <ref>/);
});

test("config.bashAllow prefixes are included in the write profile's allowedTools", () => {
  const rt = setupRuntime("ok");
  withPluginData(rt.dataDir, () => setConfig(rt.repoDir, "bashAllow", ["npm run lint"]));

  const result = runCompanion(rt, ["task", "--json", "Lint the project"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.match(invocations[0].allowedTools, /Bash\(npm run lint:\*\)/);
  // The default allowlist is still present alongside the configured one.
  assert.match(invocations[0].allowedTools, /Bash\(git status:\*\)/);
});

// --- task: prompt / model forwarding ----------------------------------------

test("task forwards the prompt after --", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "Refactor the parser"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].prompt, "Refactor the parser");
  assert.equal(invocations[0].argv[invocations[0].argv.length - 2], "--");
  assert.equal(invocations[0].argv[invocations[0].argv.length - 1], "Refactor the parser");
});

test("task reads the prompt from piped stdin", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task"], { input: "Prompt via stdin\n" });

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].prompt, /Prompt via stdin/);
});

// --- task / review: --prompt-file, --focus-file, --out (A4, A5) --------------

test("task --prompt-file reads the prompt from a file relative to the command cwd", () => {
  const rt = setupRuntime("ok");
  const subDir = path.join(rt.repoDir, "sub");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "prompt.txt"), "Prompt from a file.\n", "utf8");

  // The path is relative to the invocation cwd (the repo root), not the task cwd.
  const result = runCompanion(rt, ["task", "--json", "--prompt-file", "sub/prompt.txt"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].prompt, /^Prompt from a file\./);
});

test("task --prompt-file combined with a positional prompt is an error", () => {
  const rt = setupRuntime("ok");
  fs.writeFileSync(path.join(rt.repoDir, "prompt.txt"), "From file\n", "utf8");

  const result = runCompanion(rt, ["task", "--prompt-file", "prompt.txt", "and positional"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /either --prompt-file <path> or a positional prompt, not both/);
  assert.equal(readInvocations(rt.invocationsLog).length, 0, "claude must never be invoked");
});

test("task --prompt-file --background stores the prompt text, not the path", () => {
  const rt = setupRuntime("ok");
  fs.writeFileSync(path.join(rt.repoDir, "prompt.txt"), "Background prompt from file.\n", "utf8");

  const launch = runCompanion(rt, ["task", "--json", "--background", "--prompt-file", "prompt.txt"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].prompt, /^Background prompt from file\./);
});

test("adversarial-review --focus-file reads the focus text from a file", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const f = 1;\n", "utf8");
  fs.writeFileSync(path.join(rt.repoDir, "focus.txt"), "Focus on auth boundaries.\n", "utf8");

  const result = runCompanion(rt, ["adversarial-review", "--json", "--scope", "working-tree", "--focus-file", "focus.txt"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.match(invocations[0].prompt, /Focus on auth boundaries\./);
});

test("adversarial-review --focus-file combined with positional focus is an error", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "focus.txt"), "From file\n", "utf8");

  const result = runCompanion(rt, ["adversarial-review", "--focus-file", "focus.txt", "and positional"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /either --focus-file <path> or positional focus text, not both/);
  assert.equal(readInvocations(rt.invocationsLog).length, 0, "claude must never be invoked");
});

test("review rejects --focus-file", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);

  const result = runCompanion(rt, ["review", "--focus-file", "focus.txt"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review` does not support --focus-file/);
  assert.equal(readInvocations(rt.invocationsLog).length, 0, "claude must never be invoked");
});

test("--out writes only the result text, relative to the command cwd, creating parent dirs", () => {
  const rt = setupRuntime("ok", { resultText: "The clean report body.\nSecond line.\n" });
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const o = 1;\n", "utf8");

  const outPath = path.join(rt.repoDir, "reports", "nested", "review.txt");
  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree", "--out", "reports/nested/review.txt"]);

  assert.equal(result.status, 0, result.stderr);
  // stdout is unchanged: --json payload only, no report body leaked into it.
  const payload = JSON.parse(result.stdout);
  assert.match(payload.text, /The clean report body\./);
  assert.equal(fs.readFileSync(outPath, "utf8"), "The clean report body.\nSecond line.\n");

  const taskOut = path.join(rt.repoDir, "reports", "task.txt");
  const task = runCompanion(rt, ["task", "--json", "--out", "reports/task.txt", "Do a thing"]);
  assert.equal(task.status, 0, task.stderr);
  assert.equal(fs.readFileSync(taskOut, "utf8"), "The clean report body.\nSecond line.\n");
});

test("--out with no result text prints a stderr notice and writes no file", () => {
  const rt = setupRuntime("no-result-error");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const n = 1;\n", "utf8");

  const outPath = path.join(rt.repoDir, "reports", "review.txt");
  const result = runCompanion(rt, ["review", "--json", "--scope", "working-tree", "--out", "reports/review.txt"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[nano\] no result text; --out file not written/);
  assert.equal(fs.existsSync(outPath), false, "the --out file must not be created");
});

test("task --background --out writes the result file when the worker completes", () => {
  const rt = setupRuntime("ok", { resultText: "Background report body.\n" });
  const outPath = path.join(rt.repoDir, "reports", "bg.txt");

  const launch = runCompanion(rt, ["task", "--json", "--background", "--out", "reports/bg.txt", "Do a thing"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.equal(fs.existsSync(outPath), true, "worker must write the --out file");
  assert.equal(fs.readFileSync(outPath, "utf8"), "Background report body.\n");
});

test("task forwards --model (and -m alias) to the claude invocation", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--model", "z-ai/glm-5.3-flash", "Do a thing"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations[0].model, "z-ai/glm-5.3-flash");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "z-ai/glm-5.3-flash");

  const aliasResult = runCompanion(rt, ["task", "--json", "-m", "minimax/minimax-m3", "Another thing"]);
  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  const aliasInvocations = readInvocations(rt.invocationsLog);
  assert.equal(aliasInvocations[1].model, "minimax/minimax-m3");
});

test("task falls back to the default model when none is requested or configured", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "Do a thing"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "z-ai/glm-5.2");
});

// --- task: child env safety --------------------------------------------------

test("the claude child env strips host auth vars and pins default model slots", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--model", "z-ai/glm-5.2", "Do a thing"]);

  assert.equal(result.status, 0, result.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  const inv = invocations[0];

  assert.equal(inv.envNames.includes("ANTHROPIC_AUTH_TOKEN"), false);
  assert.equal(inv.envNames.includes("ANTHROPIC_MODEL"), false);
  assert.equal(inv.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "z-ai/glm-5.2");
  assert.equal(inv.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "z-ai/glm-5.2");
  assert.equal(inv.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "z-ai/glm-5.2");
  assert.equal(inv.env.ANTHROPIC_BASE_URL, rt.env.NANOGPT_BASE_URL);
  assert.equal(inv.apiKeyMatchesFake, true);
});

// --- task: run outcomes -------------------------------------------------------

test("failure behaviour exits 1 and prefixes the rendered body with a failure notice", () => {
  const rt = setupRuntime("failure");
  const result = runCompanion(rt, ["task", "Do something that fails"]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /NanoGPT run failed:/);
  assert.match(result.stdout, /API Error: simulated failure/);
});

test("denials behaviour surfaces denied tool calls in the run footer", () => {
  const rt = setupRuntime("denials");
  const result = runCompanion(rt, ["task", "Try risky things"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /denied=Bash\(rm -rf build\)/);
});

test("no-json behaviour exits 1 with the did-not-return-a-result fallback", () => {
  const rt = setupRuntime("no-json");
  const result = runCompanion(rt, ["task", "Do a thing"]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /NanoGPT did not return a result\./);
});

test("long results are truncated inline and the full text is available via /nano:result", () => {
  const rt = setupRuntime("long");
  const result = runCompanion(rt, ["task", "Summarize a big file"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /truncated, full output: \/nano:result (\S+)/);
  const [, jobId] = result.stdout.match(/\/nano:result (\S+)/);

  const full = runCompanion(rt, ["result", jobId, "--json"]);
  assert.equal(full.status, 0, full.stderr);
  const payload = JSON.parse(full.stdout);
  assert.match(payload.storedJob.result.rawOutput, /^L{20000}$/);
});

test("task --json payload has the documented shape", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--model", "z-ai/glm-5.2", "Do a thing"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(
    new Set(Object.keys(payload)),
    new Set([
      "status",
      "isError",
      "rawOutput",
      "error",
      "claudeSessionId",
      "model",
      "profile",
      "bashAllow",
      "usage",
      "permissionDenials",
      "numTurns",
      "durationMs",
      "quota",
      "stopReason",
      "salvaged",
      "maxTurns",
      "stderr",
      "warnings",
      "footer"
    ])
  );
  assert.equal(payload.status, 0);
  assert.equal(payload.isError, false);
  assert.match(payload.rawOutput, /Fake NanoGPT result\./);
  assert.ok(payload.claudeSessionId);
  assert.equal(payload.model, "z-ai/glm-5.2");
  assert.equal(payload.profile, "write");
  assert.deepEqual(payload.bashAllow, [...DEFAULT_BASH_ALLOW]);
  assert.equal(typeof payload.usage, "object");
  assert.deepEqual(payload.permissionDenials, []);
  assert.equal(payload.numTurns, 3);
  assert.equal(typeof payload.durationMs, "number");
  // The base URL is unreachable (http://127.0.0.1:9), so the quota snapshot
  // fails fast and quota is null; the run did not hit the turn cap.
  assert.equal(payload.quota, null);
  assert.equal(payload.stopReason, null);
  assert.equal(payload.maxTurns, 25);
  assert.equal(payload.stderr, "");
  assert.match(payload.footer, /^\[nano\] model=z-ai\/glm-5\.2/);
});

// --- task: metrics log --------------------------------------------------------

test("a task run appends one runs.jsonl line with the nano-agent field names", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--model", "z-ai/glm-5.2", "Summarize"]);
  assert.equal(result.status, 0, result.stderr);

  const runsFile = path.join(rt.dataDir, "runs.jsonl");
  const lines = fs.readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
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
  assert.equal(entry.kind, "task");
  assert.equal(entry.exit, 0);
  assert.equal(entry.subtype, "success");
  assert.equal(entry.maxTurns, 25);
  assert.equal(entry.salvaged, null);
  assert.equal(entry.error, null);
  assert.equal(entry.promptBytes, Buffer.byteLength("Summarize", "utf8"));
  assert.ok(entry.wallMs >= 0);
  assert.equal(entry.calls.length, 2, "two distinct assistant message ids");
  assert.deepEqual(Object.keys(entry.calls[0]), ["ms", "in", "cache_read", "cache_creation", "out"]);
  assert.equal(entry.calls[0].out, 20, "token counts come from the last event for an id");
  assert.equal(entry.model, "z-ai/glm-5.2");
  assert.equal(entry.cwd, rt.repoDir);
  assert.equal(entry.is_error, false);
  // The base URL is unreachable (http://127.0.0.1:9), so the quota snapshot
  // fails fast and quotaDelta is null.
  assert.equal(entry.quotaDelta, null);
});

// --- turn caps: defaults, overrides, invalid values, background, --continue ---

test("a task passes --max-turns 25 by default", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "Do a thing"]);
  assert.equal(result.status, 0, result.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].maxTurns, "25");
});

test("review and adversarial-review pass --max-turns 15 by default", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 1;\n", "utf8");

  const review = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);
  assert.equal(review.status, 0, review.stderr);
  let invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].maxTurns, "15");

  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const x = 2;\n", "utf8");
  const adversarial = runCompanion(rt, ["adversarial-review", "--json", "--scope", "working-tree"]);
  assert.equal(adversarial.status, 0, adversarial.stderr);
  invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].maxTurns, "15");
});

test("--max-turns 7 overrides the task default", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--max-turns", "7", "Do a thing"]);
  assert.equal(result.status, 0, result.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].maxTurns, "7");
});

test("an invalid --max-turns exits 1 with no claude invocation", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--max-turns", "0", "Do a thing"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --max-turns/);
  assert.equal(fs.existsSync(rt.invocationsLog), false, "claude must never be invoked for an invalid --max-turns");
});

test("a background task passes the --max-turns cap on to the worker", () => {
  const rt = setupRuntime("ok");
  const launch = runCompanion(rt, ["task", "--json", "--background", "--max-turns", "9", "Refactor the parser"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].maxTurns, "9");
});

// Regression test for a cross-process race between enqueueBackgroundTask
// (which used to spawn the detached worker before writing its job file/index
// record) and the worker's first read of that same job by id: launching
// several background jobs back to back used to be able to lose a job's
// queued record, or hand the worker a job file that did not exist yet.
test("5 background tasks launched back to back are all found by status --wait and complete, with exactly 5 fake invocations", () => {
  const rt = setupRuntime("ok");

  const jobIds = Array.from({ length: 5 }, (_, index) => {
    const launch = runCompanion(rt, ["task", "--json", "--background", `Task number ${index}`]);
    assert.equal(launch.status, 0, launch.stderr);
    return JSON.parse(launch.stdout).jobId;
  });
  assert.equal(new Set(jobIds).size, 5, "expected 5 distinct job ids");

  for (const jobId of jobIds) {
    const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
    assert.equal(waited.status, 0, waited.stderr);
    const snapshot = JSON.parse(waited.stdout);
    assert.equal(snapshot.job.id, jobId);
    assert.equal(snapshot.job.status, "completed", JSON.stringify(snapshot.job));
  }

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 5);
});

test("task --continue does not carry an old --max-turns cap over", () => {
  const rt = setupRuntime("ok");
  const first = runCompanion(rt, ["task", "--json", "--max-turns", "3", "First task"]);
  assert.equal(first.status, 0, first.stderr);

  const second = runCompanion(rt, ["task", "--json", "--continue", "Second task"]);
  assert.equal(second.status, 0, second.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].maxTurns, "3");
  // --continue uses this run's flag (none given here) or the default, never
  // the previous run's cap.
  assert.equal(invocations[1].maxTurns, "25");
});

// --- turn caps: hitting the limit ----------------------------------------------

test("a task exits 1 with the turn-limit message and stopReason max_turns", () => {
  const rt = setupRuntime("max-turns");
  const result = runCompanion(rt, ["task", "--json", "Do a big thing"]);

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stopReason, "max_turns");
  assert.equal(payload.maxTurns, 25);
  assert.equal(payload.isError, true);

  const rendered = runCompanion(rt, ["task", "Do a big thing"]);
  assert.equal(rendered.status, 1);
  assert.match(rendered.stdout, /Stopped at the turn limit \(25 turns\) before finishing\./);
});

test("a background job that hits the turn cap ends failed with the turn-limit message", () => {
  const rt = setupRuntime("max-turns");
  const launch = runCompanion(rt, ["task", "--json", "--background", "Do a big thing"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "failed");
  assert.match(snapshot.job.summary, /Stopped at the turn limit \(25 turns\)/);
});

test("task --continue resumes a job that stopped at the turn limit", () => {
  const rt = setupRuntime("max-turns");
  const first = runCompanion(rt, ["task", "--json", "First task"]);
  assert.equal(first.status, 1);
  const firstPayload = JSON.parse(first.stdout);
  assert.ok(firstPayload.claudeSessionId, "a max-turns stop still records a session id");

  const second = runCompanion(rt, ["task", "--json", "--continue", "--no-salvage", "Second task"]);
  assert.equal(second.status, 1, second.stderr);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 3, "first run, its failed salvage call, then the continue");
  assert.equal(invocations[2].resume, firstPayload.claudeSessionId);
});

// --- turn limit: salvage -------------------------------------------------------

function readRunLog(rt) {
  return fs
    .readFileSync(path.join(rt.dataDir, "runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSalvageInvocation(invocation, sessionId) {
  assert.equal(invocation.resume, sessionId);
  assert.equal(invocation.tools, "", "an empty --tools= disables every tool");
  assert.ok(invocation.argv.includes("--tools="));
  assert.equal(invocation.maxTurns, "1");
  assert.equal(invocation.allowedTools, null);
  assert.equal(
    invocation.argv.some((arg) => arg.startsWith("--allowedTools")),
    false,
    "the salvage call must not allow any tool"
  );
  assert.equal(invocation.permissionMode, "dontAsk");
  assert.equal(invocation.restricted, true);
  assert.equal(invocation.strictMcpConfig, true);
}

test("a task that hits the turn cap is salvaged with a no-tools resume", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok", salvageText: "Did A and B; C remains." });
  const outFile = path.join(rt.repoDir, "out", "task.md");
  const result = runCompanion(rt, ["task", "--json", "--max-turns", "4", "--out", outFile, "Do a big thing"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.isError, false);
  assert.equal(payload.rawOutput, "Did A and B; C remains.");
  assert.equal(payload.stopReason, "max_turns");
  assert.equal(payload.salvaged, true);
  assert.deepEqual(payload.salvageUsage, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 10
  });
  // usage is the sum of both calls
  assert.equal(payload.usage.input_tokens, 1100);
  assert.equal(payload.usage.cache_read_input_tokens, 900);
  assert.equal(payload.usage.output_tokens, 250);
  assert.match(payload.footer, /tokens=2000in\/250out/);
  assert.ok(payload.claudeSessionId);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].outputFormat, "stream-json");
  assert.equal(invocations[0].maxTurns, "4");
  assertSalvageInvocation(invocations[1], payload.claudeSessionId);
  assert.equal(invocations[1].model, invocations[0].model);
  assert.equal(invocations[1].cwd, invocations[0].cwd);
  assert.match(invocations[1].prompt, /^You have reached the turn limit\. Do not call any tools\. Summarize what you did/);

  assert.equal(fs.readFileSync(outFile, "utf8"), "Did A and B; C remains.\n", "--out gets the salvaged text");

  const rendered = runCompanion(rt, ["task", "Do a big thing"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(
    rendered.stdout,
    /^Stopped at the turn limit \(25 turns\)\. Summary of progress so far — continue with --continue or rerun with a higher --max-turns\.\n\nDid A and B; C remains\./
  );

  const [first] = readRunLog(rt);
  assert.equal(first.kind, "task");
  assert.equal(first.stopReason, "max_turns");
  assert.equal(first.salvaged, true);
  assert.equal(first.is_error, false);
  assert.equal(first.exit, 0);
  assert.equal(first.subtype, "error_max_turns");
  assert.equal(first.terminalReason, "max_turns");
  assert.equal(first.maxTurns, 4);
  assert.equal(first.in, 1100, "in includes the salvage call");
  assert.equal(first.cache_read, 900);
  assert.equal(first.out, 250);
  assert.equal(first.cache_creation, 10);
  assert.equal(first.error, null);
  assert.deepEqual(Object.keys(first.salvage), ["in", "cache_read", "out", "ms"]);
  assert.equal(first.salvage.in, 100);
  assert.equal(first.calls.at(-1).salvage, true);
  assert.equal(first.calls.length, 3, "two streamed calls plus the salvage call");
  assert.equal(typeof first.callMsMax, "number");
  assert.equal(typeof first.callMsP50, "number");
});

test("a review that hits the turn cap is finalized by the salvage call", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok", salvageText: "Found one bug in app.js." });
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const k = 1;\n", "utf8");
  const outFile = path.join(rt.repoDir, "review.md");
  const result = runCompanion(rt, ["review", "--scope", "working-tree", "--out", outFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finalized at the turn limit \(15 turns\); some areas may be unchecked\.\n\nFound one bug in app\.js\./);
  assert.doesNotMatch(result.stdout, /Stopped at the turn limit/);
  assert.equal(fs.readFileSync(outFile, "utf8"), "Found one bug in app.js.\n");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assertSalvageInvocation(invocations[1], readRunLog(rt)[0].session);
  assert.match(invocations[1].prompt, /Write your final review now, in the required output format/);
  assert.match(invocations[1].prompt, /short list of areas you did not get to check/);

  const json = JSON.parse(runCompanion(rt, ["adversarial-review", "--json", "--scope", "working-tree"]).stdout);
  assert.equal(json.salvaged, true);
  assert.equal(json.stopReason, "max_turns");
  assert.equal(json.text, "Found one bug in app.js.");
  assert.ok(readRunLog(rt).some((entry) => entry.kind === "adversarial-review" && entry.salvaged === true));
});

test("a failed salvage call leaves the turn-limit failure exactly as before", () => {
  const rt = setupRuntime("max-turns", { salvage: "error" });
  const outFile = path.join(rt.repoDir, "out.md");
  const result = runCompanion(rt, ["task", "--json", "--out", outFile, "Do a big thing"]);

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.isError, true);
  assert.equal(payload.stopReason, "max_turns");
  assert.equal(payload.salvaged, false);
  assert.equal("salvageUsage" in payload, false);
  assert.equal(payload.rawOutput, "");
  assert.equal(payload.usage.input_tokens, 1000, "usage is only the original call when salvage fails");
  assert.equal(fs.existsSync(outFile), false, "--out is not written when the run ends as an error");

  const rendered = runCompanion(rt, ["task", "Do a big thing"]);
  assert.equal(rendered.status, 1);
  assert.match(rendered.stdout, /Stopped at the turn limit \(25 turns\) before finishing\./);

  const [entry] = readRunLog(rt);
  assert.equal(entry.salvaged, false);
  assert.equal(entry.is_error, true);
  assert.equal(entry.stopReason, "max_turns");
  assert.equal(entry.in, 1100, "the log still counts the tokens the failed salvage call spent");
  assert.ok(entry.salvage);
  assert.ok(entry.error && entry.error.length <= 500);
});

test("--no-salvage disables the salvage call for tasks and reviews", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok" });
  const task = runCompanion(rt, ["task", "--json", "--no-salvage", "Do a big thing"]);
  assert.equal(task.status, 1);
  const payload = JSON.parse(task.stdout);
  assert.equal(payload.salvaged, null);
  assert.equal(payload.stopReason, "max_turns");

  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const k = 1;\n", "utf8");
  const review = runCompanion(rt, ["review", "--no-salvage", "--scope", "working-tree"]);
  assert.equal(review.status, 1);
  assert.match(review.stdout, /Stopped at the turn limit \(15 turns\) before finishing\./);

  assert.equal(readInvocations(rt.invocationsLog).length, 2, "one claude call per run, no salvage");
  assert.equal(readRunLog(rt)[0].salvaged, null);
});

test("a background task that hits the turn cap is salvaged and completes", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok", salvageText: "Background summary." });
  const launch = runCompanion(rt, ["task", "--json", "--background", "Do a big thing"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");

  const stored = JSON.parse(runCompanion(rt, ["result", jobId, "--json"]).stdout);
  assert.equal(stored.storedJob.result.salvaged, true);
  assert.equal(stored.storedJob.result.stopReason, "max_turns");
  assert.ok(stored.storedJob.claudeSessionId, "the session id stays so --continue works");
  const text = runCompanion(rt, ["result", jobId]);
  assert.match(text.stdout, /^Stopped at the turn limit \(25 turns\)\. Summary of progress so far/);
  assert.match(text.stdout, /Background summary\./);

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assertSalvageInvocation(invocations[1], stored.storedJob.claudeSessionId);
  const [entry] = readRunLog(rt);
  assert.equal(entry.jobId, jobId);
  assert.equal(entry.salvaged, true);

  const log = fs.readFileSync(snapshot.job.logFile, "utf8");
  assert.match(log, /Read /, "background jobs still stream tool progress into the job log");
});

test("--no-salvage is stored in a background task request", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok" });
  const launch = runCompanion(rt, ["task", "--json", "--background", "--no-salvage", "Do a big thing"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(JSON.parse(waited.stdout).job.status, "failed");
  assert.equal(readInvocations(rt.invocationsLog).length, 1);
});

test("the stop-gate review salvages with a verdict prompt and logs kind stop-gate", () => {
  const rt = setupRuntime("max-turns", { salvage: "ok", salvageText: "ALLOW: nothing found" });
  const env = { ...rt.env, NANO_COMPANION_JOB_ORIGIN: "stop-gate" };
  const result = runCompanion(rt, ["task", "--json", "--read-only", "--max-turns", "15", "Review the last change"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "ALLOW: nothing found");
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.match(invocations[1].prompt, /ALLOW: <short reason>/);
  assert.equal(readRunLog(rt)[0].kind, "stop-gate");
});

test("run log entries record failure details and never contain the API key", () => {
  const rt = setupRuntime("failure");
  const failed = runCompanion(rt, ["task", "--json", "Break"]);
  assert.equal(failed.status, 1);
  const noResult = setupRuntime("no-result-error");
  const crashed = runCompanion(noResult, ["task", "--json", "Break"]);
  assert.equal(crashed.status, 1);

  const [entry] = readRunLog(rt);
  assert.equal(entry.is_error, true);
  assert.equal(entry.error, "API Error: simulated failure");
  assert.equal(entry.exit, 1);
  assert.equal(entry.salvaged, null);

  const [crash] = readRunLog(noResult);
  assert.equal(crash.turns, null);
  assert.match(crash.error, /^claude exited 1: Error: piped stdin input exceeds 10MB/);
  assert.ok(crash.error.length <= 500);

  for (const dir of [rt.dataDir, noResult.dataDir]) {
    for (const file of walkFiles(dir)) {
      assert.equal(fs.readFileSync(file, "utf8").includes(FAKE_API_KEY), false, `${file} must not contain the API key`);
    }
  }
});

// --- usage subcommand ---------------------------------------------------------

test("usage summarizes the run log and the MCP call log", () => {
  const rt = setupRuntime("ok");
  assert.equal(runCompanion(rt, ["task", "--json", "Summarize"]).status, 0);
  const old = { ts: "2020-01-01T00:00:00.000Z", model: "x", in: 5, out: 5, is_error: false, turns: 1 };
  fs.appendFileSync(path.join(rt.dataDir, "runs.jsonl"), `${JSON.stringify(old)}\n`);
  fs.writeFileSync(
    path.join(rt.dataDir, "mcp-calls.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), tool: "nanogpt_chat", ok: true, ms: 1500, model: "m", usage: { total_tokens: 42 }, error: null, media: ["/a.png"] })}\n`
  );

  const text = runCompanion(rt, ["usage"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /last 7 days/);
  assert.match(text.stdout, /runs\.jsonl/);
  assert.match(text.stdout, /Totals: 1 runs \(1 ok, 0 error\)/);
  assert.match(text.stdout, /- task: 1 runs/);
  assert.match(text.stdout, /nanogpt_chat: 1 calls/);

  const json = JSON.parse(runCompanion(rt, ["usage", "--json", "--days", "3650"]).stdout);
  assert.equal(json.totals.runs, 2);
  assert.equal(json.mcp.mediaFiles, 1);
  assert.equal(json.days, 3650);

  const bad = runCompanion(rt, ["usage", "--days", "0"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid --days/);
  assert.equal(runCompanion(rt, ["usage", "--days", "1.5"]).status, 1);
});

test("usage works with no logs at all", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["usage"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Totals: 0 runs/);
  assert.match(result.stdout, /not found/);
});

// --- task: --continue ---------------------------------------------------------

test("task --continue resumes the newest finished task's session, model, profile, and cwd", () => {
  const rt = setupRuntime("ok");
  const subDir = path.join(rt.repoDir, "sub");
  fs.mkdirSync(subDir);

  const first = runCompanion(rt, [
    "task",
    "--json",
    "--cwd",
    subDir,
    "--read-only",
    "--model",
    "z-ai/glm-5.3-flash",
    "First task"
  ]);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.ok(firstPayload.claudeSessionId);
  assert.equal(firstPayload.profile, "read");

  const second = runCompanion(rt, ["task", "--json", "--continue", "Second task"]);
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.profile, "read");
  assert.equal(secondPayload.model, "z-ai/glm-5.3-flash");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].resume, firstPayload.claudeSessionId);
  assert.equal(invocations[1].cwd, subDir);
  assert.equal(invocations[1].model, "z-ai/glm-5.3-flash");
  assert.equal(invocations[1].tools, "Read,Glob,Grep");
  assert.match(invocations[1].prompt, /Second task/);
});

test("task --continue with an empty prompt defaults to a continue message", () => {
  const rt = setupRuntime("ok");
  const first = runCompanion(rt, ["task", "--json", "First task"]);
  assert.equal(first.status, 0, first.stderr);

  const second = runCompanion(rt, ["task", "--continue"]);
  assert.equal(second.status, 0, second.stderr);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations[1].prompt, "Continue from where you left off.");
});

test("task --continue with no prior task errors clearly", () => {
  const rt = setupRuntime("ok");
  const result = runCompanion(rt, ["task", "--json", "--continue"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No resumable NanoGPT task found/);
});

// --- task: background ---------------------------------------------------------

test("task --background runs via a detached worker and produces a completed job", () => {
  const rt = setupRuntime("ok");
  const launch = runCompanion(rt, ["task", "--json", "--background", "Refactor the parser"]);

  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.ok(launchPayload.jobId);

  const waited = runCompanion(rt, [
    "status",
    launchPayload.jobId,
    "--wait",
    "--json",
    "--timeout-ms",
    "20000",
    "--poll-interval-ms",
    "200"
  ]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");

  const result = runCompanion(rt, ["result", launchPayload.jobId, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.storedJob.result.rawOutput, /Fake NanoGPT result\./);
});

test("a background task streams stream-json progress into the job log and records claudeSessionId", async () => {
  const rt = setupRuntime("ok");
  const launch = runCompanion(rt, ["task", "--json", "--background", "Stream progress"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = await runCompanion(rt, [
    "status",
    jobId,
    "--wait",
    "--json",
    "--timeout-ms",
    "15000",
    "--poll-interval-ms",
    "200"
  ]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");

  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].outputFormat, "stream-json");
  assert.equal(invocations[0].verbose, true);
  assert.ok(invocations[0].pid);

  const logText = fs.readFileSync(snapshot.job.logFile, "utf8");
  assert.match(logText, /NanoGPT session \S+ started \(model/);
  assert.match(logText, /\] Read README\.md/);
  assert.match(logText, /\] Bash git diff --stat/);

  // The fake uses one session id for both its init line and its result object,
  // so the stored claudeSessionId can be cross-checked against both.
  const [, loggedSessionId] = logText.match(/NanoGPT session (\S+) started/);
  const stored = withPluginData(rt.dataDir, () => JSON.parse(fs.readFileSync(resolveJobFile(rt.repoDir, jobId), "utf8")));
  assert.equal(typeof stored.claudeSessionId, "string");
  assert.ok(stored.claudeSessionId.length > 0);
  assert.equal(stored.claudeSessionId, loggedSessionId);
  assert.equal(stored.claudeSessionId, stored.result.claudeSessionId);
});

test("a background task can be cancelled while running and resumed with --continue", async () => {
  const rt = setupRuntime("slow", { delayMs: 20000 });
  const launch = runCompanion(rt, ["task", "--json", "--background", "Slow background work"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  // The fake prints its init line before sleeping, so the session id lands in
  // the stored job file while the run is still in progress.
  const jobFilePath = withPluginData(rt.dataDir, () => resolveJobFile(rt.repoDir, jobId));
  const storedWhileRunning = await waitFor("the job file to gain a claudeSessionId", () => {
    if (!fs.existsSync(jobFilePath)) {
      return null;
    }
    const stored = JSON.parse(fs.readFileSync(jobFilePath, "utf8"));
    return typeof stored.claudeSessionId === "string" && stored.claudeSessionId.length > 0 ? stored : null;
  });
  const claudeSessionId = storedWhileRunning.claudeSessionId;

  const status = runCompanion(rt, ["status", jobId, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.job.status, "running");
  assert.ok(
    statusPayload.job.phase === "starting" || statusPayload.job.phase === "running",
    `unexpected phase ${statusPayload.job.phase}`
  );
  assert.ok(statusPayload.job.progressPreview.length > 0, "expected a progress preview");

  const cancel = runCompanion(rt, ["cancel", jobId, "--json"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");

  // The worker is a detached process-group leader and claude is its child in
  // the same group, so the group kill takes out both.
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].pid);
  await waitFor("the fake claude process to die", () => isProcessGone(invocations[0].pid), 5000);

  const finalStatus = runCompanion(rt, ["status", jobId, "--json"]);
  assert.equal(finalStatus.status, 0, finalStatus.stderr);
  assert.equal(JSON.parse(finalStatus.stdout).job.status, "cancelled");

  // The cancelled job keeps its session id so task --continue can resume it.
  const storedAfterCancel = JSON.parse(fs.readFileSync(jobFilePath, "utf8"));
  assert.equal(storedAfterCancel.claudeSessionId, claudeSessionId);

  const resume = runCompanion(rt, ["task", "--json", "--continue", "keep going"]);
  assert.equal(resume.status, 0, resume.stderr);
  const resumeInvocations = readInvocations(rt.invocationsLog);
  assert.equal(resumeInvocations.length, 2);
  assert.equal(resumeInvocations[1].resume, claudeSessionId);
  assert.match(resumeInvocations[1].prompt, /keep going/);
});

test("task --continue skips stop-gate review jobs and resumes the rescue session with the write profile", () => {
  const rt = setupRuntime("ok");
  const env = { ...rt.env, NANO_COMPANION_SESSION_ID: "claude-session-1" };

  const rescue = runCompanion(rt, ["task", "--json", "Fix the parser"], { env });
  assert.equal(rescue.status, 0, rescue.stderr);
  const rescuePayload = JSON.parse(rescue.stdout);
  assert.equal(rescuePayload.profile, "write");
  assert.ok(rescuePayload.claudeSessionId);

  // The stop gate runs a read-only review task in the same Claude session.
  withPluginData(rt.dataDir, () => setConfig(rt.repoDir, "stopReviewGate", true));
  const gate = run(process.execPath, [STOP_HOOK], {
    cwd: rt.repoDir,
    env,
    input: JSON.stringify({ session_id: "claude-session-1", cwd: rt.repoDir, last_assistant_message: "Done fixing." })
  });
  assert.equal(gate.status, 0, gate.stderr);
  const afterGate = readInvocations(rt.invocationsLog);
  assert.equal(afterGate.length, 2);
  assert.equal(afterGate[1].tools, "Read,Glob,Grep");
  assert.match(afterGate[1].prompt, /Done fixing\./);

  const jobs = withPluginData(rt.dataDir, () => listJobs(rt.repoDir));
  const gateJobs = jobs.filter((job) => job.origin === "stop-gate");
  assert.equal(gateJobs.length, 1);
  assert.equal(gateJobs[0].status, "completed");

  const candidate = runCompanion(rt, ["task-resume-candidate", "--json"], { env });
  assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(candidatePayload.available, true);
  assert.notEqual(candidatePayload.candidate.id, gateJobs[0].id);

  const resume = runCompanion(rt, ["task", "--json", "--continue", "apply the fix"], { env });
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).profile, "write");
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 3);
  assert.equal(invocations[2].resume, rescuePayload.claudeSessionId);
  assert.equal(invocations[2].tools, "Read,Glob,Grep,Edit,Write,Bash");
});

test("a background run that dies after reporting its session keeps the session id for --continue", () => {
  const rt = setupRuntime("crash-after-init");
  const launch = runCompanion(rt, ["task", "--json", "--background", "Crashy work"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const waited = runCompanion(rt, [
    "status",
    jobId,
    "--wait",
    "--json",
    "--timeout-ms",
    "15000",
    "--poll-interval-ms",
    "200"
  ]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "failed");

  const logText = fs.readFileSync(snapshot.job.logFile, "utf8");
  const [, loggedSessionId] = logText.match(/NanoGPT session (\S+) started/);
  const stored = withPluginData(rt.dataDir, () => JSON.parse(fs.readFileSync(resolveJobFile(rt.repoDir, jobId), "utf8")));
  assert.equal(stored.claudeSessionId, loggedSessionId);
  assert.equal(stored.result.claudeSessionId, loggedSessionId);
  const indexEntry = withPluginData(rt.dataDir, () => listJobs(rt.repoDir)).find((job) => job.id === jobId);
  assert.equal(indexEntry.claudeSessionId, loggedSessionId);

  // The fake crashes again, but the resumed invocation targets the session.
  runCompanion(rt, ["task", "--json", "--continue", "try again"]);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].resume, loggedSessionId);
});

test("the background worker rebuilds permissions from the profile name and rejects tampered requests", () => {
  const rt = setupRuntime("ok");
  const seed = (jobId, requestPatch) =>
    withPluginData(rt.dataDir, () => {
      const logFile = resolveJobLogFile(rt.repoDir, jobId);
      fs.writeFileSync(logFile, "", "utf8");
      const record = {
        id: jobId,
        kind: "task",
        kindLabel: "rescue",
        title: "NanoGPT Task",
        jobClass: "task",
        status: "queued",
        phase: "queued",
        workspaceRoot: rt.repoDir,
        logFile,
        createdAt: new Date().toISOString(),
        request: { cwd: rt.repoDir, model: "z-ai/glm-5.2", prompt: "Tampered", profile: "read", bashAllow: [], jobId, ...requestPatch }
      };
      writeJobFile(rt.repoDir, jobId, record);
      upsertJob(rt.repoDir, record);
    });

  // A ready-made profile object smuggling Bash into a "read" run.
  seed("task-tampered-profile", {
    profile: { name: "read", tools: ["Read", "Bash"], allowedTools: ["Read", "Bash"], bashAllow: [] }
  });
  const byObject = runCompanion(rt, ["task-worker", "--cwd", rt.repoDir, "--job-id", "task-tampered-profile"]);
  assert.notEqual(byObject.status, 0);
  assert.match(byObject.stderr, /Invalid permission profile/);

  // A Bash prefix that tries to break out of its Bash(<prefix>:*) rule.
  seed("task-tampered-bash", { profile: "write", bashAllow: ["git status:*),Bash(rm"] });
  const byPrefix = runCompanion(rt, ["task-worker", "--cwd", rt.repoDir, "--job-id", "task-tampered-bash"]);
  assert.notEqual(byPrefix.status, 0);
  assert.match(byPrefix.stderr, /Invalid Bash allowlist prefix/);

  assert.equal(readInvocations(rt.invocationsLog).length, 0);
  const jobs = withPluginData(rt.dataDir, () => listJobs(rt.repoDir));
  for (const id of ["task-tampered-profile", "task-tampered-bash"]) {
    assert.equal(jobs.find((job) => job.id === id).status, "failed");
  }
});

// --- status / result / cancel -------------------------------------------------

test("status and result work for a completed foreground task", () => {
  const rt = setupRuntime("ok");
  const taskResult = runCompanion(rt, ["task", "--json", "Summarize the repo"]);
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const status = runCompanion(rt, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished, "expected a finished job");
  assert.equal(statusPayload.latestFinished.status, "completed");
  const jobId = statusPayload.latestFinished.id;

  const single = runCompanion(rt, ["status", jobId, "--json"]);
  assert.equal(single.status, 0, single.stderr);
  const singlePayload = JSON.parse(single.stdout);
  assert.equal(singlePayload.job.id, jobId);
  assert.equal(singlePayload.job.status, "completed");

  const resultOut = runCompanion(rt, ["result", jobId, "--json"]);
  assert.equal(resultOut.status, 0, resultOut.stderr);
  const resultPayload = JSON.parse(resultOut.stdout);
  assert.equal(resultPayload.job.id, jobId);
  assert.match(resultPayload.storedJob.result.rawOutput, /Fake NanoGPT result\./);
});

test("cancel marks an active job as cancelled", () => {
  const rt = setupRuntime("ok");
  // Seed a "running" job directly into the isolated state so cancel is
  // deterministic (no reliance on detached background workers).
  withPluginData(rt.dataDir, () => {
    const jobId = "task-seeded-1";
    const logFile = resolveJobLogFile(rt.repoDir, jobId);
    fs.writeFileSync(logFile, "", "utf8");
    const record = {
      id: jobId,
      kind: "task",
      kindLabel: "rescue",
      title: "NanoGPT Task",
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
  });

  const cancel = runCompanion(rt, ["cancel", "task-seeded-1", "--json"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.jobId, "task-seeded-1");
  assert.equal(cancelPayload.status, "cancelled");

  const status = runCompanion(rt, ["status", "task-seeded-1", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.job.status, "cancelled");
});

// --- key never persisted ------------------------------------------------------

test("the NanoGPT API key is never persisted in state, logs, or command output", () => {
  const rt = setupRuntime("ok");

  const fg = runCompanion(rt, ["task", "--json", "Foreground task"]);
  assert.equal(fg.status, 0, fg.stderr);

  const bg = runCompanion(rt, ["task", "--json", "--background", "Background task"]);
  assert.equal(bg.status, 0, bg.stderr);
  const bgPayload = JSON.parse(bg.stdout);
  const waited = runCompanion(rt, [
    "status",
    bgPayload.jobId,
    "--wait",
    "--json",
    "--timeout-ms",
    "20000",
    "--poll-interval-ms",
    "200"
  ]);
  assert.equal(waited.status, 0, waited.stderr);

  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const k = 1;\n", "utf8");
  const review = runCompanion(rt, ["review", "--json", "--scope", "working-tree"]);
  assert.equal(review.status, 0, review.stderr);

  for (const output of [fg, bg, waited, review]) {
    assert.equal(output.stdout.includes(FAKE_API_KEY), false, "stdout must never contain the fake API key");
    assert.equal(output.stderr.includes(FAKE_API_KEY), false, "stderr must never contain the fake API key");
  }

  for (const filePath of [...walkFiles(rt.dataDir), rt.invocationsLog]) {
    const content = fs.readFileSync(filePath, "utf8");
    assert.equal(content.includes(FAKE_API_KEY), false, `${filePath} must never contain the fake API key`);
  }
});

// --- robustness: redaction, --out safety, spill cleanup -----------------------

function allText(rt, extra = []) {
  return [...walkFiles(rt.dataDir), ...extra].map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
}

function waitForJob(rt, jobId) {
  const waited = runCompanion(rt, ["status", jobId, "--wait", "--json", "--timeout-ms", "20000", "--poll-interval-ms", "200"]);
  assert.equal(waited.status, 0, waited.stderr);
  return { waited, job: JSON.parse(waited.stdout).job };
}

test("the API key is redacted from stderr, result text and clipped errors (foreground and background)", () => {
  const cases = [
    ["stderr, no result", "no-result-error", { stderrText: `claude failed: ${FAKE_API_KEY}` }],
    ["result text", "ok", { resultText: `The key is ${FAKE_API_KEY} ok` }],
    ["key crossing the 500-char clip", "no-result-error", { stderrText: `${"p".repeat(490)}${FAKE_API_KEY}` }]
  ];
  for (const [label, behavior, options] of cases) {
    // foreground
    const fg = setupRuntime(behavior, options);
    const fgResult = runCompanion(fg, ["task", "--json", "Do a thing"]);
    assert.equal(fgResult.stdout.includes(FAKE_API_KEY), false, `${label}: foreground stdout`);
    assert.equal(fgResult.stderr.includes(FAKE_API_KEY), false, `${label}: foreground stderr`);
    assert.equal(allText(fg).includes(FAKE_API_KEY), false, `${label}: foreground job/log/runs files`);
    assert.equal(allText(fg).includes(FAKE_API_KEY.slice(0, 12)), false, `${label}: foreground key prefix`);

    // background
    const bg = setupRuntime(behavior, options);
    const launch = runCompanion(bg, ["task", "--json", "--background", "Do a thing"]);
    assert.equal(launch.status, 0, launch.stderr);
    const { jobId } = JSON.parse(launch.stdout);
    const { waited } = waitForJob(bg, jobId);
    assert.equal(waited.stdout.includes(FAKE_API_KEY), false, `${label}: status output`);
    // The worker may still be flushing the run log after the job turns terminal.
    const text = allText(bg);
    assert.equal(text.includes(FAKE_API_KEY), false, `${label}: background job/log/runs files`);
    assert.equal(text.includes(FAKE_API_KEY.slice(0, 12)), false, `${label}: background key prefix`);
  }
});

test("--out refuses a symlink destination and leaves its target untouched", () => {
  const rt = setupRuntime("ok", { resultText: "New report.\n" });
  const target = path.join(rt.repoDir, "target.txt");
  fs.writeFileSync(target, "precious\n");
  fs.symlinkSync(target, path.join(rt.repoDir, "link.txt"));

  const result = runCompanion(rt, ["task", "--json", "--out", "link.txt", "Do a thing"]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "precious\n");
  assert.match(result.stderr, /symlink/);
  assert.match(JSON.parse(result.stdout).outError, /symlink/);
});

test("--out overwrites an existing regular file atomically and leaves no temp files", () => {
  const rt = setupRuntime("ok", { resultText: "Fresh report.\n" });
  fs.writeFileSync(path.join(rt.repoDir, "report.txt"), "old\n");

  const result = runCompanion(rt, ["task", "--json", "--out", "report.txt", "Do a thing"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(rt.repoDir, "report.txt"), "utf8"), "Fresh report.\n");
  assert.deepEqual(fs.readdirSync(rt.repoDir).filter((name) => name.endsWith(".tmp")), []);
});

test("a failed --out write fails a foreground review and says why", () => {
  const rt = setupRuntime("ok", { resultText: "Review body.\n" });
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), "export const o = 1;\n", "utf8");
  fs.mkdirSync(path.join(rt.repoDir, "outdir"));

  const result = runCompanion(rt, ["review", "--scope", "working-tree", "--out", "outdir"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Could not write --out file .*outdir: destination is a directory\s*$/);

  const json = runCompanion(rt, ["review", "--json", "--scope", "working-tree", "--out", "outdir"]);
  assert.notEqual(json.status, 0);
  const payload = JSON.parse(json.stdout);
  assert.match(payload.outError, /directory/);
  assert.notEqual(payload.status, 0);
});

test("a failed --out write marks a background task job failed", () => {
  const rt = setupRuntime("ok", { resultText: "Background body.\n" });
  fs.mkdirSync(path.join(rt.repoDir, "outdir"));

  const launch = runCompanion(rt, ["task", "--json", "--background", "--out", "outdir", "Do a thing"]);
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const { job } = waitForJob(rt, jobId);
  assert.equal(job.status, "failed");
  const stored = withPluginData(rt.dataDir, () => JSON.parse(fs.readFileSync(resolveJobFile(rt.repoDir, jobId), "utf8")));
  assert.match(stored.result.outError, /directory/);
  assert.match(stored.rendered, /Could not write --out file/);
});

test("an oversized review prompt leaves no spill directory behind", () => {
  const rt = setupRuntime("ok");
  commitInitial(rt.repoDir);
  fs.writeFileSync(path.join(rt.repoDir, "app.js"), `${"y".repeat(5000)}\n`, "utf8");
  fs.writeFileSync(path.join(rt.repoDir, "focus.txt"), "f".repeat(11 * 1024 * 1024), "utf8");
  const tmp = makeTempDir("nano-tmpdir-");
  const env = { ...rt.env, TMPDIR: tmp, NANO_REVIEW_INLINE_BYTES: "1000" };

  const result = runCompanion(rt, ["adversarial-review", "--scope", "working-tree", "--focus-file", "focus.txt"], { env });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Prompt is \d+ bytes/);
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("nano-review-")), []);
});
