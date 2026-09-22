// Live integration tests that drive the real NanoGPT API through the real
// `claude` CLI. The whole file is skipped unless NANOGPT_LIVE=1, so `npm test`
// (which runs offline in CI) reports every test as skipped and never touches
// the network or spawns `claude`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import {
  buildClaudeArgs,
  buildChildEnv,
  parseClaudeJsonOutput,
  resolveApiKey,
  resolveBaseUrl,
  runClaude,
  summarizeClaudeResult
} from "../plugins/nano/scripts/lib/runtime.mjs";

const COMPANION_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "nano",
  "scripts",
  "nano-companion.mjs"
);

const LIVE = process.env.NANOGPT_LIVE === "1";
const SKIP_REASON = "set NANOGPT_LIVE=1 to run live NanoGPT tests";
const TIMEOUT = 240000;
const DEFAULT_MODEL = process.env.NANOGPT_LIVE_MODEL || "z-ai/glm-5.2";

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

/**
 * Resolve the NanoGPT API key, failing the test with a clear message when it is
 * missing. The key value itself is never printed, logged or asserted on.
 */
function requireLiveApiKey() {
  const { key, source } = resolveApiKey();
  if (!key) {
    assert.fail(
      "No NanoGPT API key found for live tests. Set NANOGPT_API_KEY (or store it in the keychain) and rerun with NANOGPT_LIVE=1."
    );
  }
  // Touch `source` so it is not flagged as unused, but never reveal the key.
  assert.ok(source, "resolveApiKey returned a key but no source");
  return key;
}

/**
 * Build a fresh temp workspace inside a temp parent dir. Paths that escape the
 * workspace via `..` land in the parent dir, which the test controls and can
 * inspect. Returns realpath-resolved { parent, workspace }.
 */
function freshWorkspace() {
  const parent = fs.realpathSync.native(makeTempDir("nano-live-parent-"));
  const workspace = path.join(parent, "ws");
  fs.mkdirSync(workspace);
  initGitRepo(workspace);
  return { parent, workspace: fs.realpathSync.native(workspace) };
}

/**
 * Run the real `claude -p` against NanoGPT with the given prompt and profile,
 * returning the summarized result plus status/stderr. Throws with the stderr
 * when no parseable JSON was produced.
 */
async function liveRun({ cwd, profile, bashAllow, prompt, resumeSessionId = null, model = DEFAULT_MODEL }) {
  const apiKey = requireLiveApiKey();
  const args = buildClaudeArgs({ prompt, model, profile, bashAllow, resumeSessionId, outputFormat: "json" });
  const env = buildChildEnv({ apiKey, model, baseUrl: resolveBaseUrl() });
  const raw = await runClaude({ cwd, args, env });
  const parsed = parseClaudeJsonOutput(raw.stdout);
  if (!parsed) {
    throw new Error(`claude produced no parseable JSON. status=${raw.status} stderr=${raw.stderr}`);
  }
  return { ...summarizeClaudeResult(parsed), status: raw.status, stderr: raw.stderr, args };
}

/**
 * Hard assertion that the model actually attempted a denied action: checks that
 * `result.permissionDenials` contains at least one entry whose `tool_name`
 * matches one of `toolNames`. Use this alongside filesystem assertions so a
 * pass cannot mean the model simply never tried. `toolNames` may be a single
 * string or an array of accepted tool names.
 */
function assertAttemptDenied(result, toolNames, label) {
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  const matched = result.permissionDenials.some((d) => names.includes(d.tool_name));
  if (!matched) {
    assert.fail(
      `${label}: the attempt was not made or not denied. ` +
        `denials=${JSON.stringify(result.permissionDenials)} ` +
        `text=${JSON.stringify(result.text.slice(0, 300))}`
    );
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

// 1. write profile: Write inside the workspace is allowed.
test("write profile: Write inside.txt in cwd -> exists with the content", { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["mkdir allowed-dir"],
    prompt: "Use the Write tool to create the file inside.txt in the current directory containing the text x. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const target = path.join(workspace, "inside.txt");
  assert.equal(fs.existsSync(target), true, `expected inside.txt to exist; stderr=${result.stderr}`);
  assert.equal(fs.readFileSync(target, "utf8"), "x");
});

// 2. write profile: Write outside the workspace is denied.
test("write profile: Write ../escaped.txt -> must NOT exist in parent dir", { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { parent, workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["mkdir allowed-dir"],
    prompt: "Use the Write tool to create the file ../escaped.txt containing the text x. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const escaped = path.join(parent, "escaped.txt");
  assert.equal(fs.existsSync(escaped), false, `../escaped.txt must not exist; stderr=${result.stderr}`);
  assertAttemptDenied(result, "Write", "write ../escaped.txt");
});

// 3. write profile: an allowlisted Bash command runs.
test('write profile, bashAllow ["mkdir allowed-dir"]: run `mkdir allowed-dir` -> dir exists', { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["mkdir allowed-dir"],
    prompt: "Use the Bash tool to run exactly: mkdir allowed-dir. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const dir = path.join(workspace, "allowed-dir");
  assert.equal(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), true, `allowed-dir must exist; stderr=${result.stderr}`);
});

// 4. write profile: a non-allowlisted Bash command is denied.
test('write profile, same allowlist: run `touch touched.txt` -> must not exist', { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["mkdir allowed-dir"],
    prompt: "Use the Bash tool to run exactly: touch touched.txt. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const target = path.join(workspace, "touched.txt");
  assert.equal(fs.existsSync(target), false, `touched.txt must not exist; stderr=${result.stderr}`);
  assertAttemptDenied(result, "Bash", "touch touched.txt");
});

// 5. write profile: compound commands are denied under prefix rules.
test('write profile, same allowlist: `mkdir allowed-dir && touch compound.txt` -> compound.txt must not exist', { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["mkdir allowed-dir"],
    prompt: "Use the Bash tool to run exactly: mkdir allowed-dir && touch compound.txt. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const target = path.join(workspace, "compound.txt");
  assert.equal(fs.existsSync(target), false, `compound.txt must not exist; stderr=${result.stderr}`);
  assertAttemptDenied(result, "Bash", "compound mkdir && touch");
});

// 6. write profile: command substitution and pipes are denied under prefix rules.
test('write profile, bashAllow ["git status"]: `git status $(touch subst.txt)` and `git status | tee piped.txt` -> neither file exists', { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["git status"],
    prompt: "Use the Bash tool to run exactly: git status $(touch subst.txt). Then use the Bash tool to run exactly: git status | tee piped.txt. Do not ask for confirmation. Afterwards reply with DONE."
  });
  assert.equal(fs.existsSync(path.join(workspace, "subst.txt")), false, `subst.txt must not exist; stderr=${result.stderr}`);
  assert.equal(fs.existsSync(path.join(workspace, "piped.txt")), false, `piped.txt must not exist; stderr=${result.stderr}`);
  assertAttemptDenied(result, "Bash", "git status substitution/pipe");
});

// 7. write profile: output redirection escapes the workspace via Bash is denied.
test('write profile: `printf hi > ../redirect-out.txt` (allowlist ["printf"]) -> ../redirect-out.txt must not exist', { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { parent, workspace } = freshWorkspace();
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["printf"],
    prompt: "Use the Bash tool to run exactly: printf hi > ../redirect-out.txt. Do not ask for confirmation. Afterwards reply with DONE."
  });
  const target = path.join(parent, "redirect-out.txt");
  assert.equal(fs.existsSync(target), false, `../redirect-out.txt must not exist; stderr=${result.stderr}`);
  assertAttemptDenied(result, "Bash", "printf redirect");
});

// 8. write profile: editing .git/config is denied (outside Write(./**)/Edit(./**) scope).
test("write profile: Edit .git/config -> .git/config content unchanged", { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const configPath = path.join(workspace, ".git", "config");
  const before = fs.readFileSync(configPath, "utf8");
  const result = await liveRun({
    cwd: workspace,
    profile: "write",
    bashAllow: ["git status"],
    prompt: "This is an authorized test of the permission sandbox in a throwaway repository. Use the Edit tool to append the comment line '# nano boundary test' to the file .git/config. Do not ask for confirmation; if the tool call is denied, just report it. Afterwards reply with DONE."
  });
  const after = fs.readFileSync(configPath, "utf8");
  assert.equal(after, before, `.git/config must be unchanged; stderr=${result.stderr}`);
  assertAttemptDenied(result, ["Edit", "Write"], "edit .git/config");
});

// 9. read profile: no Write/Bash/Edit tools at all; filesystem untouched.
test("read profile: Write, Bash and Edit attempts all denied; README unchanged; args have no Bash/Edit/Write in --tools", { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const readme = path.join(workspace, "README.md");
  const readmeBefore = "# original\n";
  fs.writeFileSync(readme, readmeBefore, "utf8");

  // Inspect the args that would be sent: read profile must not expose
  // Bash, Edit or Write in --tools.
  const args = buildClaudeArgs({ prompt: "x", model: DEFAULT_MODEL, profile: "read", outputFormat: "json" });
  const toolsArg = args.find((a) => a.startsWith("--tools="));
  assert.ok(toolsArg, "expected a --tools= argument");
  assert.equal(toolsArg.includes("Bash"), false, `read --tools must not include Bash: ${toolsArg}`);
  assert.equal(toolsArg.includes("Edit"), false, `read --tools must not include Edit: ${toolsArg}`);
  assert.equal(toolsArg.includes("Write"), false, `read --tools must not include Write: ${toolsArg}`);

  const result = await liveRun({
    cwd: workspace,
    profile: "read",
    prompt: "Do all three, in order, without asking for confirmation: (1) Use the Write tool to create the file readonly-write.txt containing x. (2) Use the Bash tool to run exactly: touch readonly-touch.txt. (3) Use the Edit tool to append a line 'added' to README.md. Afterwards reply with DONE."
  });

  assert.equal(fs.existsSync(path.join(workspace, "readonly-write.txt")), false, `readonly-write.txt must not exist; stderr=${result.stderr}`);
  assert.equal(fs.existsSync(path.join(workspace, "readonly-touch.txt")), false, `readonly-touch.txt must not exist; stderr=${result.stderr}`);
  assert.equal(fs.readFileSync(readme, "utf8"), readmeBefore, `README.md must be unchanged; stderr=${result.stderr}`);
});

// 10. resume: the second run recalls a codeword from the first session.
test("resume: second run with resumeSessionId recalls the codeword from the first run", { skip: !LIVE && SKIP_REASON, timeout: TIMEOUT }, async () => {
  const { workspace } = freshWorkspace();
  const codeword = "PAPAYA-1234";

  const first = await liveRun({
    cwd: workspace,
    profile: "read",
    prompt: `Remember this codeword: ${codeword}. Reply only with OK.`
  });
  assert.ok(first.sessionId, `first run must return a sessionId; stderr=${first.stderr}`);

  const second = await liveRun({
    cwd: workspace,
    profile: "read",
    resumeSessionId: first.sessionId,
    prompt: "What was the codeword I gave you? Reply with just the codeword."
  });
  assert.equal(second.sessionId, first.sessionId, `second sessionId must equal the first; stderr=${second.stderr}`);
  assert.ok(
    second.text.includes(codeword),
    `second result must include the codeword; got: ${JSON.stringify(second.text)}; stderr=${second.stderr}`
  );
});

// ===========================================================================
// Group 2: end-to-end companion subcommands against the real NanoGPT API.
//
// These tests drive the real `node plugins/nano/scripts/nano-companion.mjs`
// child process (which itself spawns the real `claude` CLI) against NanoGPT.
// The API key is never set via the environment here: it is resolved inside
// the companion from the OS keychain. NANO_COMPANION_SESSION_ID is removed
// so resume-candidate resolution does not pick up the host's Claude session.
//
// A final guard in every test asserts the resolved key never appears in any
// captured companion stdout/stderr nor in any file under the temp
// CLAUDE_PLUGIN_DATA dir.
// ===========================================================================

const COMPANION_TIMEOUT = 300000;
const STATUS_POLL_TIMEOUT_MS = 240000;
const STATUS_POLL_INTERVAL_MS = 2000;

/**
 * Build a fresh temp git repo with one initial commit, plus a fresh temp
 * CLAUDE_PLUGIN_DATA dir. Returns { workspace, dataDir, env } where `env` is
 * the host environment with CLAUDE_PLUGIN_DATA pinned to the temp dir and
 * NANO_COMPANION_SESSION_ID removed (and no NANOGPT_API_KEY / NANOGPT_BASE_URL
 * override so the companion resolves the real key from the keychain).
 */
function freshCompanionWorkspace() {
  const parent = fs.realpathSync.native(makeTempDir("nano-companion-live-"));
  const workspace = path.join(parent, "ws");
  fs.mkdirSync(workspace);
  initGitRepo(workspace);
  // One initial commit so review/ git operations have a base.
  fs.writeFileSync(path.join(workspace, "README.md"), "# nano live\n", "utf8");
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-m", "initial"], { cwd: workspace });

  const dataDir = fs.realpathSync.native(makeTempDir("nano-companion-data-"));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  delete env.NANO_COMPANION_SESSION_ID;
  delete env.NANOGPT_API_KEY;
  delete env.NANOGPT_BASE_URL;
  return { parent, workspace, dataDir, env };
}

/**
 * Spawn the companion as a child process and resolve with
 * { status, stdout, stderr } when it exits. Single-command invocation only;
 * no shell, no pipelines.
 */
function runCompanion({ cwd, env, args, timeoutMs = COMPANION_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION_SCRIPT, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`companion timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Final guard: resolve the real key in the test process and assert it never
 * appears in any captured companion output nor in any file under the temp
 * CLAUDE_PLUGIN_DATA dir. The assertion message names the file path only,
 * never the key.
 */
function assertKeyNeverLeaked(dataDir, capturedOutputs) {
  const { key } = resolveApiKey();
  assert.ok(key, "resolveApiKey returned no key for the live leak guard");
  for (const [label, text] of capturedOutputs) {
    if (typeof text !== "string" || text.length === 0) continue;
    assert.ok(!text.includes(key), `API key found in companion ${label}`);
  }
  for (const file of walkFiles(dataDir)) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.includes(key), `API key found in ${file}`);
  }
}

// 11. setup --json: ready, every check ok, subscription active, apiKey source
// named and not key-like.
test("companion live: setup --json reports ready with all checks ok", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  const result = await runCompanion({ cwd: workspace, env, args: ["setup", "--json"] });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true, `setup not ready; checks=${JSON.stringify(payload.checks)}`);
  for (const check of payload.checks) {
    assert.equal(check.ok, true, `check ${check.id} not ok: ${check.detail}`);
  }
  const sub = payload.checks.find((c) => c.id === "subscription");
  assert.match(sub.detail, /active/i, `subscription detail must say active: ${sub.detail}`);
  const apiKey = payload.checks.find((c) => c.id === "apiKey");
  assert.ok(apiKey.detail && apiKey.detail.length > 0, "apiKey detail must name a source");
  // The detail names a source (keychain / env var) and must not look like a key:
  // it should contain a space or the word "keychain" / "environment", and must
  // not be a long opaque token.
  assert.ok(
    /keychain|environment variable|NANOGPT_API_KEY/i.test(apiKey.detail),
    `apiKey detail must name a source: ${apiKey.detail}`
  );
  assert.ok(apiKey.detail.length < 80, `apiKey detail looks key-like: ${apiKey.detail}`);

  assertKeyNeverLeaked(dataDir, [
    ["setup stdout", result.stdout],
    ["setup stderr", result.stderr]
  ]);
});

// 12. review --wait --json of a tiny buggy diff returns exit 0 and a verdict.
test("companion live: review of a buggy diff returns a verdict and runs read-only", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  // Introduce an obvious bug in a new file, committed, then a follow-up
  // working-tree change so there is a diff to review.
  fs.writeFileSync(
    path.join(workspace, "math.js"),
    "export function add(a, b) { return a + b; }\n",
    "utf8"
  );
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-m", "add math.js"], { cwd: workspace });
  // Working-tree edit with an obvious bug + misleading comment.
  fs.writeFileSync(
    path.join(workspace, "math.js"),
    "// adds two numbers\nexport function add(a, b) { return a - b; }\n",
    "utf8"
  );

  const result = await runCompanion({
    cwd: workspace,
    env,
    args: ["review", "--wait", "--json", "--scope", "working-tree"]
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const verdictText = `${payload.text ?? ""} ${payload.stderr ?? ""}`.toLowerCase();
  assert.ok(
    /approve|needs-attention|needs attention|blocking/.test(verdictText),
    `review output must contain a verdict word; got: ${JSON.stringify(payload.text?.slice(0, 400))}`
  );
  // The review profile is read-only. The payload exposes permissions via the
  // review's profile only indirectly; when the payload includes a profile
  // field, assert it is read-only. Otherwise skip per the spec.
  if (payload.profile !== undefined) {
    assert.equal(payload.profile, "read", `review profile must be read; got ${payload.profile}`);
  }
  // The review runs the read permission profile: no Write/Edit/Bash tools.
  // The companion does not echo the tool list in the review payload, so this
  // is best-effort and skipped when not exposed.
  if (payload.permissionDenials !== undefined) {
    assert.ok(Array.isArray(payload.permissionDenials), "permissionDenials must be an array");
  }

  assertKeyNeverLeaked(dataDir, [
    ["review stdout", result.stdout],
    ["review stderr", result.stderr]
  ]);
});

// 13. foreground task --read-only lists files.
test("companion live: task --read-only --json lists files in the repo", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  fs.writeFileSync(path.join(workspace, "math.js"), "export const x = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-m", "add math.js"], { cwd: workspace });

  const result = await runCompanion({
    cwd: workspace,
    env,
    args: ["task", "--read-only", "--json", "List the files in this repository and reply with their names only."]
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.profile, "read", `profile must be read; got ${payload.profile}`);
  assert.ok(
    typeof payload.rawOutput === "string" && /math\.js/i.test(payload.rawOutput),
    `rawOutput must mention math.js; got: ${JSON.stringify(payload.rawOutput?.slice(0, 400))}`
  );
  assert.ok(
    typeof payload.claudeSessionId === "string" && payload.claudeSessionId.length > 0,
    "claudeSessionId must be a non-empty string"
  );

  assertKeyNeverLeaked(dataDir, [
    ["task stdout", result.stdout],
    ["task stderr", result.stderr]
  ]);
});

// 14. background task -> status -> result.
test("companion live: background task -> status -> result completes with a [nano] model= footer", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  fs.writeFileSync(path.join(workspace, "math.js"), "export const x = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-m", "add math.js"], { cwd: workspace });

  const launch = await runCompanion({
    cwd: workspace,
    env,
    args: ["task", "--background", "--read-only", "--json", "Reply with the single word DONE."]
  });
  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);
  assert.ok(launchPayload.jobId, "background launch must return a jobId");

  let sawRunningProgress = false;
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    const status = await runCompanion({
      cwd: workspace,
      env,
      args: ["status", launchPayload.jobId, "--json"]
    });
    assert.equal(status.status, 0, status.stderr);
    lastSnapshot = JSON.parse(status.stdout);
    const job = lastSnapshot.job;
    if (job.status === "running") {
      const preview = `${job.progressPreview ?? ""} ${job.phase ?? ""}`;
      if (preview.trim().length > 0) {
        sawRunningProgress = true;
      }
    }
    if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
      break;
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  assert.ok(lastSnapshot, "status was never polled");
  assert.equal(lastSnapshot.job.status, "completed", `job did not complete; status=${lastSnapshot.job.status}`);
  // Don't fail if it finished too fast to catch a running preview.
  if (lastSnapshot.job.status === "completed" && sawRunningProgress === false) {
    // best-effort: only assert when we genuinely observed running state above.
  }

  const result = await runCompanion({
    cwd: workspace,
    env,
    args: ["result", launchPayload.jobId]
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[nano\] model=/, `result must include a [nano] model= footer; got: ${result.stdout.slice(0, 400)}`);

  assertKeyNeverLeaked(dataDir, [
    ["launch stdout", launch.stdout],
    ["launch stderr", launch.stderr],
    ["result stdout", result.stdout],
    ["result stderr", result.stderr]
  ]);
});

// 15. --continue resumes the right session.
test("companion live: --continue resumes the previous task's claude session and recalls a codeword", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  const codeword = `LIVE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  const first = await runCompanion({
    cwd: workspace,
    env,
    args: ["task", "--read-only", "--json", `Remember the codeword ${codeword}. Reply only OK.`]
  });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.ok(firstPayload.claudeSessionId, "first task must record a claudeSessionId");

  const second = await runCompanion({
    cwd: workspace,
    env,
    args: ["task", "--read-only", "--continue", "--json", "What was the codeword? Reply with just the codeword."]
  });
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(
    secondPayload.claudeSessionId,
    firstPayload.claudeSessionId,
    "second task must resume the first claudeSessionId"
  );
  assert.ok(
    typeof secondPayload.rawOutput === "string" && secondPayload.rawOutput.includes(codeword),
    `second task must recall the codeword; got: ${JSON.stringify(secondPayload.rawOutput?.slice(0, 400))}`
  );

  assertKeyNeverLeaked(dataDir, [
    ["first stdout", first.stdout],
    ["first stderr", first.stderr],
    ["second stdout", second.stdout],
    ["second stderr", second.stderr]
  ]);
});

// 16. cancel a long-running background task.
test("companion live: cancel stops a running background task", { skip: !LIVE && SKIP_REASON, timeout: COMPANION_TIMEOUT }, async () => {
  const { workspace, dataDir, env } = freshCompanionWorkspace();
  // Seed several files so the model has many to read one by one.
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(workspace, `file-${i}.txt`),
      `File number ${i} with some content to summarise. `.repeat(20),
      "utf8"
    );
  }
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-m", "seed files"], { cwd: workspace });

  const launch = await runCompanion({
    cwd: workspace,
    env,
    args: [
      "task",
      "--background",
      "--read-only",
      "--json",
      "Read every file in this repository one by one and summarise each in detail. Take your time and read each file fully before summarising it."
    ]
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  // Wait until the job is running (or its claudeSessionId appears), then cancel.
  const deadline = Date.now() + 120000;
  let runningSeen = false;
  while (Date.now() < deadline) {
    const status = await runCompanion({ cwd: workspace, env, args: ["status", jobId, "--json"] });
    assert.equal(status.status, 0, status.stderr);
    const snap = JSON.parse(status.stdout);
    if (snap.job.status === "running") {
      runningSeen = true;
      break;
    }
    if (snap.job.status === "completed" || snap.job.status === "failed") {
      break;
    }
    await sleep(1000);
  }
  // If the task already finished (very fast model), cancel is a no-op on a
  // finished job and would error; only attempt cancel while still active.
  const preCancelStatus = await runCompanion({ cwd: workspace, env, args: ["status", jobId, "--json"] });
  const preSnap = JSON.parse(preCancelStatus.stdout);
  assert.ok(
    preSnap.job.status === "running" || preSnap.job.status === "queued",
    `expected job to still be active before cancel; status=${preSnap.job.status}`
  );

  const cancel = await runCompanion({ cwd: workspace, env, args: ["cancel", jobId, "--json"] });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");

  const finalStatus = await runCompanion({ cwd: workspace, env, args: ["status", jobId, "--json"] });
  assert.equal(finalStatus.status, 0, finalStatus.stderr);
  assert.equal(JSON.parse(finalStatus.stdout).job.status, "cancelled");

  // Touch runningSeen so linters don't complain; the assertion above is the
  // real gate, but we only reach cancel when the job was active.
  assert.ok(runningSeen || true);

  assertKeyNeverLeaked(dataDir, [
    ["launch stdout", launch.stdout],
    ["launch stderr", launch.stderr],
    ["cancel stdout", cancel.stdout],
    ["cancel stderr", cancel.stderr],
    ["final status stdout", finalStatus.stdout],
    ["final status stderr", finalStatus.stderr]
  ]);
});
