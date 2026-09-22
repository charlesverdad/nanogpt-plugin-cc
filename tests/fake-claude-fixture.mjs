import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `kimi` executable into `binDir`.
 *
 * Unlike codex (which speaks an app-server JSON-RPC protocol over stdio via a
 * broker), the kimi companion spawns the `kimi` CLI DIRECTLY:
 *
 *   - `kimi --version`        -> availability check (binaryAvailable)
 *   - `kimi info`             -> auth/availability probe
 *   - `kimi login --help`     -> fallback auth probe
 *   - `kimi --quiet --yolo [--model m] [--thinking] [--continue] -p <prompt>`
 *                             -> task/review run; assistant output to stdout
 *
 * So the fake mirrors that command-line contract instead of a wire protocol.
 *
 * `behavior` selects the canned response set:
 *   - "ok"           (default) version/info/login succeed; runs print a canned
 *                    assistant message to stdout and exit 0.
 *   - "auth-missing" `--version` still succeeds (binary is installed) but both
 *                    `info` and `login --help` exit non-zero, so the companion
 *                    reports not-logged-in.
 *   - "failure"      version/info/login succeed but a task/review run exits
 *                    non-zero with a message on stderr.
 *
 * Each task/review invocation appends a JSON line to `<binDir>/kimi-invocations.log`
 * recording the argv it received (and a few decoded fields), so tests can assert
 * that --model / --thinking / --continue are forwarded correctly.
 */
export function installFakeKimi(binDir, behavior = "ok") {
  const invocationsLog = path.join(binDir, "kimi-invocations.log");
  const scriptPath = path.join(binDir, "kimi");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const BEHAVIOR = ${JSON.stringify(behavior)};
const INVOCATIONS_LOG = ${JSON.stringify(invocationsLog)};
const ASSISTANT_TEXT = "Fake Kimi assistant response.\\nReviewed the provided changes; no blocking issues found.";

const argv = process.argv.slice(2);

function recordInvocation(extra) {
  const entry = Object.assign({ argv: argv, ts: Date.now() }, extra || {});
  try {
    fs.appendFileSync(INVOCATIONS_LOG, JSON.stringify(entry) + "\\n", "utf8");
  } catch (error) {
    // best-effort; never fail a run because logging failed.
  }
}

// --- Availability / auth probes -------------------------------------------

if (argv[0] === "--version") {
  // Always succeeds when the binary is installed at all.
  console.log("kimi, version 0.0.0-fake");
  process.exit(0);
}

if (argv[0] === "info") {
  if (BEHAVIOR === "auth-missing") {
    console.error("kimi: not logged in. Run \\\`kimi login\\\`.");
    process.exit(1);
  }
  console.log("kimi info");
  console.log("version: 0.0.0-fake");
  console.log("protocol: fake");
  process.exit(0);
}

if (argv[0] === "login" && argv[1] === "--help") {
  if (BEHAVIOR === "auth-missing") {
    // Make the fallback auth probe fail too so the companion reports not-ready.
    console.error("kimi: unknown command");
    process.exit(1);
  }
  console.log("Usage: kimi login [options]");
  process.exit(0);
}

if (argv[0] === "login") {
  process.exit(0);
}

// --- Task / review run ------------------------------------------------------
// Real invocation shape: kimi --quiet --yolo [--model m] [--thinking]
//                             [--continue] -p <prompt>

function parseRun(args) {
  const parsed = {
    quiet: false,
    yolo: false,
    model: null,
    thinking: false,
    continue: false,
    prompt: null
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--quiet") parsed.quiet = true;
    else if (token === "--yolo") parsed.yolo = true;
    else if (token === "--thinking") parsed.thinking = true;
    else if (token === "--continue") parsed.continue = true;
    else if (token === "--model") {
      parsed.model = args[i + 1] ?? null;
      i += 1;
    } else if (token === "-p") {
      parsed.prompt = args[i + 1] ?? null;
      i += 1;
    }
  }
  return parsed;
}

const run = parseRun(argv);
recordInvocation({
  model: run.model,
  thinking: run.thinking,
  continue: run.continue,
  prompt: run.prompt
});

if (BEHAVIOR === "failure") {
  process.stderr.write("Fake Kimi failed: simulated run error.\\n");
  process.exit(2);
}

// Echo a canned assistant message. Include a marker derived from the prompt so
// tests can confirm the prompt reached the binary.
process.stdout.write(ASSISTANT_TEXT + "\\n");
process.exit(0);
`;
  writeExecutable(scriptPath, source);

  // On Windows, spawn() resolves global binaries via .cmd wrappers.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0kimi" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "kimi.cmd"), cmdWrapper, { encoding: "utf8" });
  }

  return { scriptPath, invocationsLog };
}

/**
 * Builds an env that:
 *   - puts the fake `kimi` first on PATH, and
 *   - redirects companion state into `dataDir` (CLAUDE_PLUGIN_DATA) so tests
 *     never touch real plugin state.
 *
 * `dataDir` is optional; when omitted only PATH is adjusted.
 */
export function buildEnv(binDir, dataDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
  if (dataDir) {
    env.CLAUDE_PLUGIN_DATA = dataDir;
  } else {
    delete env.CLAUDE_PLUGIN_DATA;
  }
  // Keep job state session-agnostic by default so status/result/cancel see jobs
  // regardless of any session id inherited from the host environment.
  delete env.NANO_COMPANION_SESSION_ID;
  return env;
}

/**
 * Reads the recorded task/review invocations (argv + decoded fields).
 */
export function readInvocations(invocationsLog) {
  if (!fs.existsSync(invocationsLog)) {
    return [];
  }
  return fs
    .readFileSync(invocationsLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
