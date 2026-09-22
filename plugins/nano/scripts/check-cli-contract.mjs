#!/usr/bin/env node
// Verify that an installed `claude` (Claude Code) CLI still exposes the command
// surface this plugin depends on, by parsing `claude --help`, and that its
// version meets the plugin's minimum.
//
// Usage:
//   node plugins/nano/scripts/check-cli-contract.mjs
//
// Exit codes:
//   0  contract satisfied and version >= MIN_CLAUDE_VERSION
//   1  contract violated (a required flag/choice is missing) OR the installed
//      claude is older than MIN_CLAUDE_VERSION
//   2  `claude` binary not found on PATH
//
// This is the entry point used by the claude-cli-compat CI workflow. It is the
// real-binary counterpart to tests/cli-contract.test.mjs, and shares the same
// manifest (REQUIRED_COMMANDS) and version helpers (parseClaudeVersion,
// compareVersions, MIN_CLAUDE_VERSION) so there is a single source of truth.

import process from "node:process";

import { runCommand } from "./lib/process.mjs";
import {
  REQUIRED_COMMANDS,
  verifyContract,
  formatContractReport,
  HELP_ENV
} from "./lib/cli-contract.mjs";
import {
  MIN_CLAUDE_VERSION,
  parseClaudeVersion,
  compareVersions
} from "./lib/runtime.mjs";

// Force plain, wide help output so commander doesn't emit ANSI color codes or
// wrap option lines mid-token (see lib/cli-contract.mjs for why).
const HELP_PROCESS_ENV = { ...process.env, ...HELP_ENV };

function claudeOnPath() {
  const result = runCommand("claude", ["--version"], { env: HELP_PROCESS_ENV });
  if (result.error && result.error.code === "ENOENT") {
    return false;
  }
  // Even a non-zero exit means the binary exists; only ENOENT means missing.
  return !(result.error && result.error.code === "ENOENT");
}

/**
 * Fetch help text from the real `claude` binary. Returns combined stdout+stderr
 * because some CLIs emit help on stderr. The HELP_ENV overrides force plain,
 * wide output; the tokenizer additionally strips any ANSI that leaks through.
 */
function fetchRealHelp(argv) {
  const result = runCommand("claude", argv, {
    maxBuffer: 10 * 1024 * 1024,
    env: HELP_PROCESS_ENV
  });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function getClaudeVersion() {
  const result = runCommand("claude", ["--version"], { env: HELP_PROCESS_ENV });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || "unknown";
}

function main() {
  if (!claudeOnPath()) {
    process.stderr.write(
      "claude binary not found on PATH; cannot run real contract check.\n"
    );
    process.exitCode = 2;
    return;
  }

  const versionRaw = getClaudeVersion();
  const parsedVersion = parseClaudeVersion(versionRaw);

  process.stdout.write(`claude version: ${versionRaw}\n`);

  if (parsedVersion === null) {
    process.stderr.write(
      `\nERROR: could not parse a version from "${versionRaw}"; expected x.y.z.\n`
    );
    process.exitCode = 1;
    return;
  }

  if (compareVersions(parsedVersion, MIN_CLAUDE_VERSION) < 0) {
    process.stderr.write(
      `\nERROR: installed claude is ${parsedVersion}, which is older than the ` +
        `required minimum ${MIN_CLAUDE_VERSION}. Upgrade with ` +
        `\`npm install -g @anthropic-ai/claude-code@latest\`.\n`
    );
    process.exitCode = 1;
    return;
  }

  const verification = verifyContract(fetchRealHelp, { manifest: REQUIRED_COMMANDS });
  process.stdout.write(
    `${formatContractReport(verification, `claude CLI contract (claude ${parsedVersion})`)}\n`
  );

  if (!verification.ok) {
    process.stderr.write(
      "\nERROR: installed Claude Code is missing command surface the plugin depends on.\n"
    );
    process.exitCode = 1;
  }
}

main();
