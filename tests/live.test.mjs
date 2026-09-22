// Live integration tests that drive the real NanoGPT API through the real
// `claude` CLI. The whole file is skipped unless NANOGPT_LIVE=1, so `npm test`
// (which runs offline in CI) reports every test as skipped and never touches
// the network or spawns `claude`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, initGitRepo } from "./helpers.mjs";
import {
  buildClaudeArgs,
  buildChildEnv,
  parseClaudeJsonOutput,
  resolveApiKey,
  resolveBaseUrl,
  runClaude,
  summarizeClaudeResult
} from "../plugins/nano/scripts/lib/runtime.mjs";

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
    prompt: "Use the Edit tool to append a new line containing 'hacked = true' to the file .git/config. Do not ask for confirmation. Afterwards reply with DONE."
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
