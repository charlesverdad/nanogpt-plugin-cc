// Regression test for the `write` permission profile, run against the REAL
// `claude` binary driven by a scripted fake Anthropic endpoint
// (tests/fake-anthropic-server.mjs). It is offline and costs nothing: no
// NanoGPT call is made and the API key is a fake.
//
// Skipped unless NANO_REAL_CLAUDE=1 and `claude` is on PATH:
//   NANO_REAL_CLAUDE=1 node --test tests/real-claude-boundary.test.mjs
//
// Background: `git diff`/`git log`/`git show` accept `--output=<file>`, which
// Claude Code's Bash path checks do not inspect. With those commands on the
// default allowlist the model could write arbitrary content anywhere,
// including `.git/config` (e.g. `core.fsmonitor`), and so run any command.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  buildChildEnv,
  buildClaudeArgs,
  DEFAULT_BASH_ALLOW,
  parseClaudeJsonOutput,
  runClaude
} from "../plugins/nano/scripts/lib/runtime.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(TESTS_DIR, "fake-anthropic-server.mjs");
const MODEL = "z-ai/glm-5.2";

function claudeOnPath() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

const SKIP =
  process.env.NANO_REAL_CLAUDE !== "1"
    ? "set NANO_REAL_CLAUDE=1 to run against the real claude binary"
    : !claudeOnPath()
      ? "claude is not on PATH"
      : false;

function git(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Nano Tests", "-c", "user.email=tests@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

async function startFakeServer(steps, logFile) {
  const child = spawn(process.execPath, [FAKE_SERVER], {
    env: { ...process.env, FAKE_ANTHROPIC_STEPS: JSON.stringify(steps), FAKE_ANTHROPIC_LOG: logFile },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = buffered.match(/LISTENING (\d+)/);
      if (match) {
        resolve(match[1]);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`fake server exited early (${code})`)));
  });
  return { child, port };
}

// Run one real `claude` session that performs `steps` in order under the
// default `write` profile. Returns the parsed result plus a map of
// tool_use_id -> { isError, text } seen by the fake endpoint.
async function runScriptedClaude({ root, cwd, steps }) {
  const logFile = path.join(root, "fake-anthropic.log");
  const configDir = path.join(root, "claude-config");
  fs.mkdirSync(configDir);
  const server = await startFakeServer(steps, logFile);
  try {
    const baseEnv = { ...process.env };
    delete baseEnv.NANOGPT_API_KEY;
    const env = {
      ...buildChildEnv({ baseEnv, apiKey: "fake-offline-key", model: MODEL, baseUrl: `http://127.0.0.1:${server.port}` }),
      // Keep the run offline and away from the user's real Claude config/transcripts.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CONFIG_DIR: configDir
    };
    const args = buildClaudeArgs({ prompt: "Run the scripted steps.", model: MODEL, profile: "write", outputFormat: "json" });
    const run = await runClaude({ cwd, args, env });
    const parsed = parseClaudeJsonOutput(run.stdout);
    assert.ok(parsed, `claude returned no result JSON (exit ${run.status}): ${run.stderr}`);

    const toolResults = new Map();
    for (const line of fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)) {
      for (const result of JSON.parse(line).toolResults) {
        toolResults.set(result.toolUseId, result);
      }
    }
    return { parsed, toolResults };
  } finally {
    server.child.kill();
  }
}

test("default write profile: git --output escapes, outside writes and .git edits are denied; git status and ls run", { skip: SKIP, timeout: 180000 }, async (t) => {
  assert.deepEqual([...DEFAULT_BASH_ALLOW], ["git status", "ls"]);

  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nano-boundary-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  const outside = path.join(root, "outside");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  git(ws, ["init", "-q"]);
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "initial"]);
  const gitConfigPath = path.join(ws, ".git", "config");
  const gitConfigBefore = fs.readFileSync(gitConfigPath, "utf8");

  const steps = [
    { id: "diffOutput", name: "Bash", input: { command: "git diff --output=../diff-escape.txt", description: "diff" } },
    {
      id: "logOutput",
      name: "Bash",
      input: { command: "git log -1 --format='[core]%n\tfsmonitor = touch pwned' --output=.git/config", description: "log" }
    },
    {
      id: "showOutput",
      name: "Bash",
      input: { command: `git show --output=${path.join(outside, "show-escape.txt")} HEAD`, description: "show" }
    },
    { id: "gitStatus", name: "Bash", input: { command: "git status", description: "status" } },
    { id: "ls", name: "Bash", input: { command: "ls", description: "list" } },
    { id: "writeParent", name: "Write", input: { file_path: path.join(root, "write-escape.txt"), content: "x\n" } },
    { id: "writeAbsolute", name: "Write", input: { file_path: path.join(outside, "abs-write.txt"), content: "x\n" } },
    { id: "writeGitHook", name: "Write", input: { file_path: path.join(ws, ".git", "hooks", "pre-commit"), content: "#!/bin/sh\ntouch pwned\n" } },
    { id: "readGitConfig", name: "Read", input: { file_path: gitConfigPath } },
    {
      id: "editGitConfig",
      name: "Edit",
      input: { file_path: gitConfigPath, old_string: "[core]", new_string: "[core]\n\tfsmonitor = touch pwned" }
    },
    { id: "writeInside", name: "Write", input: { file_path: path.join(ws, "inside.txt"), content: "inside\n" } }
  ];
  const toolUseId = (id) => `toolu_step_${steps.findIndex((step) => step.id === id)}`;

  const { parsed, toolResults } = await runScriptedClaude({ root, cwd: ws, steps });
  const deniedIds = new Set((parsed.permission_denials ?? []).map((denial) => denial.tool_use_id));
  const resultFor = (id) => toolResults.get(toolUseId(id));

  // Every scripted step reached claude and produced a tool result.
  for (const step of steps) {
    assert.ok(resultFor(step.id), `no tool result for step ${step.id}`);
  }

  // git --output=<file> escapes are denied (not on the default allowlist).
  for (const id of ["diffOutput", "logOutput", "showOutput"]) {
    assert.ok(deniedIds.has(toolUseId(id)), `${id} must be a permission denial`);
    assert.equal(resultFor(id).isError, true);
  }
  assert.equal(fs.existsSync(path.join(root, "diff-escape.txt")), false);
  assert.equal(fs.existsSync(path.join(outside, "show-escape.txt")), false);

  // The allowlisted defaults still run.
  for (const id of ["gitStatus", "ls"]) {
    assert.equal(deniedIds.has(toolUseId(id)), false, `${id} must not be denied`);
    assert.equal(resultFor(id).isError, false);
  }
  assert.match(resultFor("gitStatus").text, /working tree clean|On branch/);
  assert.match(resultFor("ls").text, /a\.txt/);

  // Edit/Write are confined to cwd and kept out of .git.
  for (const id of ["writeParent", "writeAbsolute", "writeGitHook", "editGitConfig"]) {
    assert.equal(resultFor(id).isError, true, `${id} must fail`);
  }
  for (const id of ["writeGitHook", "editGitConfig"]) {
    assert.ok(deniedIds.has(toolUseId(id)), `${id} must be a permission denial`);
  }
  assert.equal(fs.existsSync(path.join(root, "write-escape.txt")), false);
  assert.equal(fs.existsSync(path.join(outside, "abs-write.txt")), false);
  assert.equal(fs.existsSync(path.join(ws, ".git", "hooks", "pre-commit")), false);
  assert.equal(fs.readFileSync(gitConfigPath, "utf8"), gitConfigBefore, ".git/config must be unchanged");
  assert.equal(fs.existsSync(path.join(ws, "pwned")), false);
  assert.deepEqual(fs.readdirSync(outside), []);

  // Control: a write inside cwd is allowed, so the harness really drives tools.
  assert.equal(resultFor("writeInside").isError, false);
  assert.equal(fs.readFileSync(path.join(ws, "inside.txt"), "utf8"), "inside\n");
});
