import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, FAKE_API_KEY, installFakeClaude, readInvocations } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "nano-companion.mjs");
const SERVER = path.join(ROOT, "tests", "fake-nanogpt-server.mjs");

const STATE_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const { setConfig, getConfig } = await import(STATE_MODULE);

import { DEFAULT_BASH_ALLOW, KEY_SETUP_COMMAND } from "../plugins/nano/scripts/lib/runtime.mjs";

function blockSystemKeychain(binDir) {
  const denyScript = "#!/usr/bin/env node\nprocess.exit(1);\n";
  writeExecutable(path.join(binDir, "security"), denyScript);
  writeExecutable(path.join(binDir, "secret-tool"), denyScript);
}

/**
 * Start the fake NanoGPT server in a separate child process, read its port
 * from stdout ("LISTENING <port>"), and return `{ port, child, stop }`.
 */
function startFakeServer(options = {}) {
  const env = {
    ...process.env,
    FAKE_NANOGPT_EXPECTED_KEY: FAKE_API_KEY,
    FAKE_NANOGPT_MODE: options.mode ?? "active"
  };
  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let port = null;
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      const match = /^LISTENING (\d+)$/.exec(line.trim());
      if (match) {
        port = Number(match[1]);
        resolve({ port, child });
      }
    };
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      if (port === null) {
        reject(new Error(`fake server did not start in time; stderr=${stderr}`));
      }
    }, 5000);
    child.once("exit", () => clearTimeout(timer));
  });
}

/**
 * Build an isolated runtime. When `server` is provided, NANOGPT_BASE_URL is
 * pointed at the fake server.
 */
function setupRuntime({ behavior = "ok", server = null, claudeVersion = "2.1.278" } = {}) {
  const binDir = makeTempDir("claude-bin-");
  const dataDir = makeTempDir("claude-data-");
  const repoDir = fs.realpathSync.native(makeTempDir("claude-repo-"));
  initGitRepo(repoDir);
  blockSystemKeychain(binDir);
  const { invocationsLog } = installFakeClaude(binDir, behavior, { version: claudeVersion });
  const extra = {};
  if (server) {
    extra.NANOGPT_BASE_URL = `http://127.0.0.1:${server.port}`;
  }
  const env = buildEnv(binDir, dataDir, extra);
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

// ---------------------------------------------------------------------------
// ready path: all checks ok against the fake server
// ---------------------------------------------------------------------------

test("setup ready=true with all checks ok against the fake server", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const result = runCompanion(rt, ["setup", "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true, JSON.stringify(payload.checks));
    const ids = payload.checks.map((c) => c.id);
    assert.deepEqual(ids, ["node", "claude", "contract", "apiKey", "ping", "subscription"]);
    for (const check of payload.checks) {
      assert.equal(check.ok, true, `${check.id} should be ok: ${check.detail}`);
    }
    assert.equal(payload.defaultModel, "z-ai/glm-5.2");
    assert.equal(payload.catalogSource, "network");
    assert.equal(payload.reviewGateEnabled, false);
    assert.deepEqual(payload.bashAllow, [...DEFAULT_BASH_ALLOW]);
    assert.equal(result.stdout.includes(FAKE_API_KEY), false, "API key leaked into setup --json output");
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// claude too old -> claude check fails
// ---------------------------------------------------------------------------

test("setup with claude 2.0.0 -> claude check fails", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server, claudeVersion: "2.0.0" });
    const result = runCompanion(rt, ["setup", "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    const claudeCheck = payload.checks.find((c) => c.id === "claude");
    assert.equal(claudeCheck.ok, false);
    assert.match(claudeCheck.detail, /2\.0\.0/);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// no key -> apiKey fails, ping/subscription skipped, nextSteps has keychain cmd
// ---------------------------------------------------------------------------

test("setup with no key -> apiKey fails, ping/subscription skipped, nextSteps has keychain command", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const env = buildEnv(rt.binDir, rt.dataDir, { NANOGPT_API_KEY: undefined, NANOGPT_BASE_URL: `http://127.0.0.1:${server.port}` });
    const result = runCompanion(rt, ["setup", "--json"], { env });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    const apiKeyCheck = payload.checks.find((c) => c.id === "apiKey");
    assert.equal(apiKeyCheck.ok, false);
    assert.equal(apiKeyCheck.detail, "not found");
    const pingCheck = payload.checks.find((c) => c.id === "ping");
    assert.equal(pingCheck.ok, false);
    assert.equal(pingCheck.detail, "skipped: no API key");
    const subCheck = payload.checks.find((c) => c.id === "subscription");
    assert.equal(subCheck.ok, false);
    assert.equal(subCheck.detail, "skipped: no API key");
    const keyStep = payload.nextSteps.find((s) => s.startsWith(KEY_SETUP_COMMAND));
    assert.ok(keyStep, "nextSteps contains the keychain command");
    assert.equal(payload.nextSteps.some((s) => s.includes(".env")), false, "nextSteps must not mention .env");
    assert.equal(result.stdout.includes(FAKE_API_KEY), false);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// inactive subscription -> subscription check fails
// ---------------------------------------------------------------------------

test("setup with inactive subscription -> subscription check fails", async () => {
  const server = await startFakeServer({ mode: "inactive" });
  try {
    const rt = setupRuntime({ server });
    const result = runCompanion(rt, ["setup", "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    const subCheck = payload.checks.find((c) => c.id === "subscription");
    assert.equal(subCheck.ok, false);
    assert.match(subCheck.detail, /inactive/);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// unreachable server -> ping fails, not ready
// ---------------------------------------------------------------------------

test("setup with unreachable server -> ping fails, not ready", () => {
  const rt = setupRuntime();
  // NANOGPT_BASE_URL points at http://127.0.0.1:9 (unreachable) via buildEnv
  const result = runCompanion(rt, ["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  const pingCheck = payload.checks.find((c) => c.id === "ping");
  assert.equal(pingCheck.ok, false);
});

// ---------------------------------------------------------------------------
// --model heavy stores z-ai/glm-5.3 and a later task uses it + 2x warning
// ---------------------------------------------------------------------------

test("setup --model heavy stores z-ai/glm-5.3 and a later task uses it with a 2x warning", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const setupResult = runCompanion(rt, ["setup", "--json", "--model", "heavy"]);
    assert.equal(setupResult.status, 0, setupResult.stderr);
    const setupPayload = JSON.parse(setupResult.stdout);
    assert.ok(
      setupPayload.actionsTaken.some((a) => a.includes("z-ai/glm-5.3")),
      "actionsTaken should record the resolved model"
    );

    // Verify config was persisted.
    const stored = withPluginData(rt.dataDir, () => getConfig(rt.repoDir));
    assert.equal(stored.model, "z-ai/glm-5.3");

    // A later task uses the stored model and emits the 2x warning.
    const taskResult = runCompanion(rt, ["task", "--json", "Do a thing"]);
    assert.equal(taskResult.status, 0, taskResult.stderr);
    const taskPayload = JSON.parse(taskResult.stdout);
    assert.equal(taskPayload.model, "z-ai/glm-5.3");
    assert.ok(taskPayload.warnings.some((w) => /2×/.test(w)), `expected a 2x warning: ${JSON.stringify(taskPayload.warnings)}`);
    assert.match(taskPayload.footer, /model=z-ai\/glm-5\.3/);
    assert.match(taskResult.stderr, /\[nano\] warning:.*2×/);

    // The human-rendered output (non-json) shows "Warning:" lines before the footer.
    const humanResult = runCompanion(rt, ["task", "Another thing"]);
    assert.equal(humanResult.status, 0, humanResult.stderr);
    assert.match(humanResult.stdout, /Warning:.*2×/);
    assert.match(humanResult.stdout, /\[nano\] model=z-ai\/glm-5\.3/);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// --model anthropic/claude-sonnet-5 is refused (paid, allowPaid false)
// ---------------------------------------------------------------------------

test("setup --model anthropic/claude-sonnet-5 is refused", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const result = runCompanion(rt, ["setup", "--json", "--model", "anthropic/claude-sonnet-5"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not included in your NanoGPT subscription/);
    assert.match(result.stderr, /--allow-paid/);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// --allow-bash "npm test" then a task has Bash(npm test:*)
// ---------------------------------------------------------------------------

test("setup --allow-bash 'npm test' then a task has Bash(npm test:*)", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const setupResult = runCompanion(rt, ["setup", "--json", "--allow-bash", "npm test"]);
    assert.equal(setupResult.status, 0, setupResult.stderr);

    const stored = withPluginData(rt.dataDir, () => getConfig(rt.repoDir));
    assert.ok(stored.bashAllow.includes("npm test"));

    const taskResult = runCompanion(rt, ["task", "--json", "Run the tests"]);
    assert.equal(taskResult.status, 0, taskResult.stderr);
    const invocations = readInvocations(rt.invocationsLog);
    assert.match(invocations[0].allowedTools, /Bash\(npm test:\*\)/);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// --disallow-bash "npm test" removes it
// ---------------------------------------------------------------------------

test("setup --disallow-bash 'npm test' removes it from config", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    withPluginData(rt.dataDir, () => setConfig(rt.repoDir, "bashAllow", ["npm test"]));

    const setupResult = runCompanion(rt, ["setup", "--json", "--disallow-bash", "npm test"]);
    assert.equal(setupResult.status, 0, setupResult.stderr);
    const payload = JSON.parse(setupResult.stdout);
    assert.ok(payload.actionsTaken.some((a) => /Removed Bash prefix: npm test/.test(a)));
    assert.equal(payload.bashAllow.includes("npm test"), false);

    const stored = withPluginData(rt.dataDir, () => getConfig(rt.repoDir));
    assert.equal(stored.bashAllow.includes("npm test"), false);
  } finally {
    server.child.kill();
  }
});

test("setup --disallow-bash with two prefixes removes both", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    withPluginData(rt.dataDir, () => setConfig(rt.repoDir, "bashAllow", ["npm test", "make", "cargo test"]));

    const setupResult = runCompanion(rt, ["setup", "--json", "--disallow-bash", "npm test", "--disallow-bash", "make"]);
    assert.equal(setupResult.status, 0, setupResult.stderr);
    const payload = JSON.parse(setupResult.stdout);
    assert.ok(payload.actionsTaken.some((a) => /Removed Bash prefix: npm test/.test(a)));
    assert.ok(payload.actionsTaken.some((a) => /Removed Bash prefix: make/.test(a)));
    assert.equal(payload.bashAllow.includes("npm test"), false);
    assert.equal(payload.bashAllow.includes("make"), false);

    const stored = withPluginData(rt.dataDir, () => getConfig(rt.repoDir));
    assert.deepEqual(stored.bashAllow, ["cargo test"]);
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// --disallow-bash ls reports built-in defaults can't be removed
// ---------------------------------------------------------------------------

test("setup --disallow-bash 'ls' reports built-in defaults cannot be removed", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const setupResult = runCompanion(rt, ["setup", "--json", "--disallow-bash", "ls"]);
    assert.equal(setupResult.status, 0, setupResult.stderr);
    const payload = JSON.parse(setupResult.stdout);
    assert.ok(
      payload.actionsTaken.some((a) => /built-in default and cannot be removed/.test(a) && /ls/.test(a)),
      `expected a built-in-default action line: ${JSON.stringify(payload.actionsTaken)}`
    );
    // ls stays in the effective allowlist
    assert.ok(payload.bashAllow.includes("ls"));
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// package.json with a test script -> nextSteps suggests /nano:setup --allow-bash "npm test"
// ---------------------------------------------------------------------------

test("package.json with a test script -> nextSteps suggests the allow-bash command, and not after allowlisting", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    fs.writeFileSync(
      path.join(rt.repoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2),
      "utf8"
    );

    const first = runCompanion(rt, ["setup", "--json"]);
    assert.equal(first.status, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    const suggestion = firstPayload.nextSteps.find((s) => s.includes('/nano:setup --allow-bash "npm test"'));
    assert.ok(suggestion, `expected the allow-bash suggestion: ${JSON.stringify(firstPayload.nextSteps)}`);
    // Allowlisting a test runner lets the model run code it writes: say so.
    assert.match(suggestion, /risk: .*run any code/);

    // After allowlisting npm test, the suggestion should disappear.
    const second = runCompanion(rt, ["setup", "--json", "--allow-bash", "npm test"]);
    assert.equal(second.status, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(
      secondPayload.nextSteps.some((s) => s.includes("npm test")),
      false,
      `suggestion should not appear after allowlisting: ${JSON.stringify(secondPayload.nextSteps)}`
    );
  } finally {
    server.child.kill();
  }
});

// ---------------------------------------------------------------------------
// Task model cases (offline builtin catalog is enough)
// ---------------------------------------------------------------------------

test("task --model fast -> z-ai/glm-5.3-flash", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--model", "fast", "Do a thing"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "z-ai/glm-5.3-flash");
});

test("task --thinking -> z-ai/glm-5.2:thinking", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--thinking", "Think hard"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "z-ai/glm-5.2:thinking");
});

test("task --model fast --thinking -> warning and base model", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--model", "fast", "--thinking", "Think"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "z-ai/glm-5.3-flash");
  assert.ok(payload.warnings.some((w) => /No z-ai\/glm-5.3-flash:thinking variant/.test(w)));
});

test("task --model anthropic/claude-sonnet-5 -> exit 1 mentioning --allow-paid, no invocation", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--model", "anthropic/claude-sonnet-5", "Do a thing"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-paid/);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 0, "no fake claude invocation should have happened");
});

test("task --model anthropic/claude-sonnet-5 --allow-paid runs (unknown to builtin -> warning)", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--model", "anthropic/claude-sonnet-5", "--allow-paid", "Do a thing"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "anthropic/claude-sonnet-5");
  assert.ok(payload.warnings.some((w) => /not in the NanoGPT catalog/.test(w)));
});

test("background task with a paid model fails immediately at enqueue", () => {
  const rt = setupRuntime();
  const result = runCompanion(rt, ["task", "--json", "--background", "--model", "anthropic/claude-sonnet-5", "Do a thing"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-paid/);
  const invocations = readInvocations(rt.invocationsLog);
  assert.equal(invocations.length, 0, "no fake claude invocation should have happened");
});

// ---------------------------------------------------------------------------
// setup --json output never contains FAKE_API_KEY (even with the server)
// ---------------------------------------------------------------------------

test("setup --json output never contains FAKE_API_KEY", async () => {
  const server = await startFakeServer();
  try {
    const rt = setupRuntime({ server });
    const result = runCompanion(rt, ["setup", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(FAKE_API_KEY), false, "API key leaked into setup --json stdout");
    assert.equal(result.stderr.includes(FAKE_API_KEY), false, "API key leaked into setup --json stderr");
  } finally {
    server.child.kill();
  }
});
