import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  REQUIRED_COMMANDS,
  verifyContract,
  tokenizeHelp,
  stripAnsi,
  normalizeHelp,
  formatContractReport,
  HELP_ENV,
  HIDDEN_FLAGS,
  verifyHiddenFlags,
  formatHiddenFlagsReport,
  buildHiddenFlagProbeArgv,
  hiddenFlagProbeEnv
} from "../plugins/nano/scripts/lib/cli-contract.mjs";
import { runCommand } from "../plugins/nano/scripts/lib/process.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { installFakeClaude } from "./fake-claude-fixture.mjs";

// A realistic commander-style `claude --help` fixture, trimmed to the option
// lines relevant to the plugin. Based on the real `claude --help` output:
// commander prints flags and short aliases comma-joined on one line, choice
// values inside `(choices: "a", "b", ...)`, and wraps long descriptions onto
// the following indented lines. The fixture keeps the wrapping so the parser
// is proven against real-world output, not a sanitized fake.
const FAKE_TOP_LEVEL_HELP = `
Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Options:
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  -h, --help                            Display help for command
  --model <model>                       Model for the current session.
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit (useful for
                                        pipes).
  --restricted                          Restricted mode: removes the built-in
                                        tools that run commands or code.
  -r, --resume [value]                  Resume a conversation by session ID, or
                                        open interactive picker with optional
                                        search term
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --tools <tools...>                    Specify the list of available tools from
                                        the built-in set.
  --verbose                             Override verbose mode setting from config
  -v, --version                         Output the version number

Commands:
  agents [options]                      Manage background agents
`;

// Same fixture with ANSI SGR codes glued onto flag tokens, to prove the
// tokenizer strips color that commander may emit under a force-color shim.
const C = "\x1b[1;36m"; // cyan bold
const R = "\x1b[0m"; // reset
const ANSI_HELP = `
Usage: claude [options] [command] [prompt]

Options:
  ${C}--allowedTools${R}, ${C}--allowed-tools${R} <tools...>
      Comma or space-separated list of tool names to allow
  ${C}-p${R}, ${C}--print${R}                       Print response and exit.
  ${C}--restricted${R}                          Restricted mode.
  ${C}--strict-mcp-config${R}                   Only use MCP servers from --mcp-config.
  ${C}--tools${R} <tools...>                    Specify the list of available tools.
  ${C}--permission-mode${R} <mode>              Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  ${C}--output-format${R} <format>              Output format (choices: "text", "json", "stream-json")
  ${C}--verbose${R}                             Override verbose mode setting from config
  ${C}-r${R}, ${C}--resume${R} [value]                  Resume a conversation by session ID
  ${C}--model${R} <model>                       Model for the current session.
  ${C}-v${R}, ${C}--version${R}                       Output the version number
`;

function fakeFetchHelp(argv) {
  // The manifest only probes ["--help"] (top-level).
  return FAKE_TOP_LEVEL_HELP;
}

test("manifest covers exactly the claude surface the plugin uses", () => {
  const topLevel = REQUIRED_COMMANDS.find((g) => g.id === "top-level");
  assert.equal(REQUIRED_COMMANDS.length, 1);
  assert.deepEqual(topLevel.argv, ["--help"]);
  const tokens = topLevel.requires.map((r) => r.token);
  for (const expected of [
    "--version",
    "-p",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "--model"
  ]) {
    assert.ok(tokens.includes(expected), `manifest must require ${expected}`);
  }
});

test("stripAnsi removes SGR color codes glued to flag tokens", () => {
  assert.equal(stripAnsi(`${C}--version${R}`), "--version");
  assert.equal(stripAnsi("\x1b[0mplain\x1b[1;36m"), "plain");
});

test("normalizeHelp collapses wrapped lines into single-spaced text", () => {
  const normalized = normalizeHelp(FAKE_TOP_LEVEL_HELP);
  assert.ok(!/\x1b/.test(normalized), "ANSI escapes should be gone");
  assert.ok(!/\n/.test(normalized), "newlines should be collapsed to spaces");
});

test("tokenizeHelp recovers flags, aliases, and quoted choice values", () => {
  const tokens = tokenizeHelp(FAKE_TOP_LEVEL_HELP);
  // Flags
  assert.ok(tokens.has("--model"));
  assert.ok(tokens.has("--tools"));
  assert.ok(tokens.has("--restricted"));
  assert.ok(tokens.has("--strict-mcp-config"));
  assert.ok(tokens.has("--allowedTools"));
  assert.ok(tokens.has("--allowed-tools"));
  assert.ok(tokens.has("--permission-mode"));
  assert.ok(tokens.has("--output-format"));
  assert.ok(tokens.has("--verbose"));
  assert.ok(tokens.has("--resume"));
  assert.ok(tokens.has("-p"));
  assert.ok(tokens.has("--print"));
  assert.ok(tokens.has("--version"));
  assert.ok(tokens.has("-v"));
  // Choice values: both quoted and unquoted forms are acceptable.
  assert.ok(tokens.has("dontAsk"), "dontAsk choice must be discoverable");
  assert.ok(tokens.has("stream-json"), "stream-json choice must be discoverable");
});

test("HELP_ENV forces plain, wide output", () => {
  assert.equal(HELP_ENV.NO_COLOR, "1");
  assert.equal(HELP_ENV.TERM, "dumb");
  assert.equal(HELP_ENV.COLUMNS, "200");
  assert.equal(HELP_ENV.FORCE_COLOR, "0");
});

test("verifyContract passes when all required tokens are present", () => {
  const verification = verifyContract(fakeFetchHelp);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "fake claude contract")
  );
  assert.deepEqual(verification.missing, []);
});

test("verifyContract satisfies -p via the --print alias", () => {
  // Remove the "-p" short form, keep only "--print".
  const help = FAKE_TOP_LEVEL_HELP.replace(/-p, --print/, "--print");
  const verification = verifyContract(() => help);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "alias -p/--print")
  );
});

test("verifyContract satisfies --allowedTools via the --allowed-tools alias", () => {
  const help = FAKE_TOP_LEVEL_HELP.replace(/--allowedTools, --allowed-tools/, "--allowed-tools");
  const verification = verifyContract(() => help);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "alias --allowedTools/--allowed-tools")
  );
});

test("verifyContract satisfies --resume via the -r alias", () => {
  const help = FAKE_TOP_LEVEL_HELP.replace(/-r, --resume/, "-r");
  const verification = verifyContract(() => help);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "alias --resume/-r")
  );
});

test("verifyContract satisfies --version via the -v alias", () => {
  const help = FAKE_TOP_LEVEL_HELP.replace(/-v, --version/, "-v");
  const verification = verifyContract(() => help);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "alias --version/-v")
  );
});

test("verifyContract finds dontAsk inside a quoted choices list", () => {
  // Keep only the quoted form, drop any bare dontAsk elsewhere.
  const help = FAKE_TOP_LEVEL_HELP.replace(
    /\(choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"\)/,
    '(choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")'
  );
  const tokens = tokenizeHelp(help);
  assert.ok(tokens.has("dontAsk"));
  const verification = verifyContract(() => help);
  assert.equal(verification.ok, true, "dontAsk must be found inside quoted choices");
});

test("verifyContract fails when a required flag is genuinely absent", () => {
  // Remove --restricted entirely (and not as a substring of anything else).
  const help = FAKE_TOP_LEVEL_HELP.replace(/--restricted[^\n]*\n\s+[^\n]*\n/, "");
  assert.ok(!tokenizeHelp(help).has("--restricted"), "sanity: --removed");
  const verification = verifyContract(() => help);
  assert.equal(verification.ok, false, "should fail when --restricted is gone");
  assert.ok(
    verification.missing.some((m) => m.token === "--restricted"),
    "missing list should call out --restricted"
  );
});

test("verifyContract fails when a required choice value is absent", () => {
  // Drop dontAsk from the choices list (it appears wrapped across lines, so
  // collapse whitespace first, then strip the quoted value).
  const help = normalizeHelp(FAKE_TOP_LEVEL_HELP).replace(/, "dontAsk"/, "");
  assert.ok(!tokenizeHelp(help).has("dontAsk"), "sanity: dontAsk removed");
  const verification = verifyContract(() => help);
  assert.equal(verification.ok, false, "should fail when dontAsk choice is gone");
  assert.ok(verification.missing.some((m) => m.token === "dontAsk"));
});

test("verifyContract passes against ANSI-colored help", () => {
  const verification = verifyContract(() => ANSI_HELP);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "ansi claude contract")
  );
});

test("verifyContract passes when option descriptions wrap across lines", () => {
  // The base fixture already wraps several descriptions; this asserts that
  // wrapped lines do not break token discovery.
  const verification = verifyContract(() => FAKE_TOP_LEVEL_HELP);
  assert.equal(verification.ok, true);
});

test("verifyContract reports a fetch failure as missing, not a crash", () => {
  const fetch = () => {
    throw new Error("boom");
  };
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.every((m) => /help fetch failed/.test(m.reason)));
});

// ---------------------------------------------------------------------------
// verifyHiddenFlags
// ---------------------------------------------------------------------------

test("verifyHiddenFlags: passes when the probe's stderr does not mention an unknown option", () => {
  const runProbe = (flag) => {
    assert.equal(flag, "--max-turns");
    return { status: 1, stdout: "", stderr: "some unrelated network error" };
  };
  const verification = verifyHiddenFlags(runProbe);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.missing, []);
  assert.equal(verification.checks.length, HIDDEN_FLAGS.length);
  assert.equal(verification.checks[0].satisfied, true);
  assert.match(formatHiddenFlagsReport(verification), /OK/);
});

test('verifyHiddenFlags: fails on stderr "error: unknown option \'--max-turns\'"', () => {
  const runProbe = () => ({
    status: 1,
    stdout: "",
    stderr: "error: unknown option '--max-turns'"
  });
  const verification = verifyHiddenFlags(runProbe);
  assert.equal(verification.ok, false);
  assert.equal(verification.missing.length, 1);
  assert.equal(verification.missing[0].flag, "--max-turns");
  assert.match(verification.missing[0].reason, /unknown option/);
  assert.match(formatHiddenFlagsReport(verification), /FAILED/);
  assert.match(formatHiddenFlagsReport(verification), /MISSING/);
});

test("verifyHiddenFlags: fails when the runner throws", () => {
  const runProbe = () => {
    throw new Error("spawn claude ENOENT");
  };
  const verification = verifyHiddenFlags(runProbe);
  assert.equal(verification.ok, false);
  assert.equal(verification.missing.length, 1);
  assert.match(verification.missing[0].reason, /probe failed: spawn claude ENOENT/);
});

test("buildHiddenFlagProbeArgv builds a minimal offline probe for the given flag", () => {
  const argv = buildHiddenFlagProbeArgv("--max-turns");
  assert.deepEqual(argv, ["-p", "--max-turns", "1", "--output-format", "json", "--tools=Read", "--", "ping"]);
});

test("hiddenFlagProbeEnv points at an unreachable base URL and strips ANTHROPIC_AUTH_TOKEN", () => {
  const env = hiddenFlagProbeEnv({ ANTHROPIC_AUTH_TOKEN: "host-token", SOME_OTHER: "kept" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9");
  assert.equal(env.ANTHROPIC_API_KEY, "contract-probe-not-a-key");
  assert.equal(env.API_TIMEOUT_MS, "3000");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false);
  assert.equal(env.SOME_OTHER, "kept");
  assert.equal(env.NO_COLOR, HELP_ENV.NO_COLOR);
});

// Run the real check-cli-contract.mjs against the fake claude binary.

const CHECK_SCRIPT = path.resolve(
  "plugins/nano/scripts/check-cli-contract.mjs"
);

test("check-cli-contract.mjs exits 0 against fake claude (ok version)", () => {
  const binDir = makeTempDir("claude-contract-test-");
  installFakeClaude(binDir);
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}` };
  const res = run(process.execPath, [CHECK_SCRIPT], { env });
  assert.equal(
    res.status,
    0,
    `expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`
  );
  assert.match(res.stdout, /claude version:/);
  assert.match(res.stdout, /claude CLI contract.*: OK/);
});

test("check-cli-contract.mjs exits 1 when claude is older than MIN_CLAUDE_VERSION", () => {
  const binDir = makeTempDir("claude-contract-test-");
  installFakeClaude(binDir, "ok", { version: "2.0.0" });
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}` };
  const res = run(process.execPath, [CHECK_SCRIPT], { env });
  assert.equal(
    res.status,
    1,
    `expected exit 1, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`
  );
  assert.match(res.stderr, /older than the required minimum/);
  assert.match(res.stderr, /2\.1\.278/);
});

// Optional real-binary check: if `claude` is installed on PATH, verify the live
// command surface too. Skips gracefully (does NOT fail) when claude is absent,
// so `npm test` works in CI without claude installed. Uses HELP_ENV so
// commander emits plain, wide output.
test("real claude CLI satisfies the contract (skipped if claude absent)", (t) => {
  const helpEnv = { ...process.env, ...HELP_ENV };
  const probe = runCommand("claude", ["--version"], { env: helpEnv });
  const claudeMissing = probe.error && probe.error.code === "ENOENT";
  if (claudeMissing) {
    t.skip("claude binary not found on PATH");
    return;
  }

  const fetchRealHelp = (argv) => {
    const result = runCommand("claude", argv, {
      maxBuffer: 10 * 1024 * 1024,
      env: helpEnv
    });
    if (result.error) {
      throw result.error;
    }
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  };

  const verification = verifyContract(fetchRealHelp);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "real claude contract")
  );
});
