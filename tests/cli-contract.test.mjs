import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_COMMANDS,
  verifyContract,
  tokenizeHelp,
  stripAnsi,
  normalizeHelp,
  formatContractReport,
  HELP_ENV
} from "../plugins/nano/scripts/lib/cli-contract.mjs";
import { runCommand } from "../plugins/nano/scripts/lib/process.mjs";

// A fake `kimi --help` fixture in the REAL Typer/Rich format: ANSI color escape
// codes, Rich box-drawing borders, an "Options" panel where flags and their
// short aliases are separated by spaces or commas, a "Commands" panel listing
// subcommands, and at least one option whose description wraps onto a second
// line. This proves the parser handles real-world output (it strips ANSI,
// drops box-drawing, and normalizes whitespace) rather than only a clean fake.
//
// Captured/derived from real `kimi --help` (kimi-cli 1.44.0+). The `\x1b[...m`
// sequences are genuine SGR color codes glued onto flag tokens, exactly as Rich
// emits them when color is on — the case that broke the original naive parser.
const C = "\x1b[1;36m"; // cyan bold (used by Rich for option/command names)
const R = "\x1b[0m"; // reset
const FAKE_TOP_LEVEL_HELP = `
 Usage: kimi [OPTIONS] COMMAND [ARGS]...

 Kimi, your next CLI agent.

╭─ Options ──────────────────────────────────────────────────────────────────╮
│ ${C}--version${R}                    ${C}-V${R}                              Show version and exit.                  │
│ ${C}--model${R}                      ${C}-m${R}     TEXT                     LLM model to use. Default: default       │
│                                                                  model set in config file.               │
│ ${C}--thinking${R}                          ${C}--no-thinking${R}           Enable thinking mode.                    │
│ ${C}--continue${R}                   ${C}-C${R}                              Continue the previous session for the    │
│                                                                  working directory. Default: no.         │
│ ${C}--yolo${R},${C}--yes${R},${C}--auto-approve${R}  ${C}-y${R}              Automatically approve all actions.       │
│ ${C}--prompt${R},${C}--command${R}           ${C}-p${R},${C}-c${R}   TEXT    User prompt to the agent. Default:       │
│                                                                  prompt interactively.                   │
│ ${C}--print${R}                                                     Run in print mode (non-interactive).     │
│ ${C}--quiet${R}                                                     Alias for \`--print --output-format text   │
│                                                                  --final-message-only\`.                  │
│ ${C}--help${R}                       ${C}-h${R}                              Show this message and exit.              │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ─────────────────────────────────────────────────────────────────╮
│ ${C}login${R}    Login to your Kimi account.                                         │
│ ${C}logout${R}   Logout from your Kimi account.                                       │
│ ${C}term${R}     Run Toad TUI backed by Kimi Code CLI ACP server.                     │
│ ${C}acp${R}      Run Kimi Code CLI ACP server.                                        │
│ ${C}info${R}     Show version and protocol information.                               │
│ ${C}export${R}   Export session data.                                                 │
│ ${C}mcp${R}      Manage MCP server configurations.                                    │
│ ${C}plugin${R}   Manage plugins.                                                      │
│ ${C}vis${R}      Run Kimi Agent Tracing Visualizer.                                   │
│ ${C}web${R}      Run Kimi Code CLI web interface.                                      │
╰──────────────────────────────────────────────────────────────────────────────╯

 Documentation:        https://moonshotai.github.io/kimi-cli/
 LLM friendly version: https://moonshotai.github.io/kimi-cli/llms.txt
`;

const FAKE_LOGIN_HELP = `
 Usage: kimi login [OPTIONS]

 Login to your Kimi account.

╭─ Options ──────────────────────────────────────────────────────────────────╮
│ ${C}--json${R}            Emit OAuth events as JSON lines.                            │
│ ${C}--help${R}            Show this message and exit.                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

function fakeFetchHelp(argv) {
  if (argv[0] === "login") {
    return FAKE_LOGIN_HELP;
  }
  // ["--help"] (top level)
  return FAKE_TOP_LEVEL_HELP;
}

test("manifest covers exactly the kimi surface the companion uses", () => {
  // Guard against silent drift: the companion relies on these tokens.
  const topLevel = REQUIRED_COMMANDS.find((g) => g.id === "top-level");
  const tokens = new Set(topLevel.requires.map((r) => r.token));
  for (const expected of [
    "--version",
    "info",
    "login",
    "--quiet",
    "--yolo",
    "--model",
    "--thinking",
    "--continue",
    "-p"
  ]) {
    assert.ok(tokens.has(expected), `manifest must require ${expected}`);
  }
});

test("stripAnsi removes SGR color codes glued to flag tokens", () => {
  assert.equal(stripAnsi(`${C}--version${R}`), "--version");
  assert.equal(stripAnsi("\x1b[0mplain\x1b[1;36m"), "plain");
});

test("normalizeHelp drops box-drawing and collapses wrapped lines", () => {
  const normalized = normalizeHelp(FAKE_TOP_LEVEL_HELP);
  assert.ok(!/[│╭╰─╮╯]/.test(normalized), "box-drawing chars should be gone");
  assert.ok(!/\x1b/.test(normalized), "ANSI escapes should be gone");
  // The wrapped "--quiet ... Alias for ..." description should still contain
  // the flag as a discoverable token.
  assert.ok(/ --quiet /.test(` ${normalized} `));
});

test("verifyContract passes against a realistic Typer/Rich fake help fixture", () => {
  const verification = verifyContract(fakeFetchHelp);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "fake kimi contract")
  );
  assert.deepEqual(verification.missing, []);
});

test("tokenizer recovers flags/aliases from colored, comma-joined option lines", () => {
  const tokens = tokenizeHelp(FAKE_TOP_LEVEL_HELP);
  // -p appears as part of "--prompt,--command -p,-c" (comma + color codes).
  assert.ok(tokens.has("-p"), "-p must survive ANSI + comma joining");
  assert.ok(tokens.has("--prompt"));
  // --thinking is printed as "--thinking --no-thinking"; base token matches.
  assert.ok(tokens.has("--thinking"));
  assert.ok(tokens.has("--version"));
  assert.ok(tokens.has("--continue"));
  assert.ok(tokens.has("--yolo"));
  // Subcommands come from the Commands panel.
  assert.ok(tokens.has("info"));
  assert.ok(tokens.has("login"));
});

test("HELP_ENV forces plain, wide output", () => {
  assert.equal(HELP_ENV.NO_COLOR, "1");
  assert.equal(HELP_ENV.TERM, "dumb");
  assert.equal(HELP_ENV.COLUMNS, "200");
});

test("verifyContract fails loudly when a required flag is genuinely absent", () => {
  // Negative fixture: a future kimi-cli that removed --yolo (and its aliases)
  // entirely. Drop the tokens from the option line so they truly vanish.
  const helpWithoutYolo = FAKE_TOP_LEVEL_HELP.replace(
    /--yolo|--yes|--auto-approve/g,
    "--gone"
  );
  const fetch = (argv) =>
    argv[0] === "login" ? FAKE_LOGIN_HELP : helpWithoutYolo;
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false, "should fail when --yolo is gone");
  assert.ok(
    verification.missing.some((m) => m.token === "--yolo"),
    "missing list should call out --yolo"
  );
});

test("verifyContract fails loudly when a required subcommand is dropped", () => {
  // Negative fixture: a future kimi-cli that removed the `info` subcommand.
  // The command name is colorized (e.g. "\x1b[1;36minfo\x1b[0m"), so target the
  // colored token rather than a plain word boundary.
  const helpWithoutInfo = FAKE_TOP_LEVEL_HELP.replace(
    `${C}info${R}`,
    `${C}gone${R}`
  );
  // Sanity: the rename actually removed the discoverable `info` token.
  assert.ok(!tokenizeHelp(helpWithoutInfo).has("info"));
  const fetch = (argv) =>
    argv[0] === "login" ? FAKE_LOGIN_HELP : helpWithoutInfo;
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.some((m) => m.token === "info"));
});

test("verifyContract reports a fetch failure as missing, not a crash", () => {
  const fetch = () => {
    throw new Error("boom");
  };
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.every((m) => /help fetch failed/.test(m.reason)));
});

// Optional real-binary check: if `kimi` is installed on PATH, verify the live
// command surface too. Skips gracefully (does NOT fail) when kimi is absent,
// so `npm test` works in CI without kimi installed. Uses HELP_ENV so Typer/Rich
// emits plain, wide output.
test("real kimi CLI satisfies the contract (skipped if kimi absent)", (t) => {
  const helpEnv = { ...process.env, ...HELP_ENV };
  const probe = runCommand("kimi", ["--version"], { env: helpEnv });
  const kimiMissing = probe.error && probe.error.code === "ENOENT";
  if (kimiMissing) {
    t.skip("kimi binary not found on PATH");
    return;
  }

  const fetchRealHelp = (argv) => {
    const result = runCommand("kimi", argv, {
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
    formatContractReport(verification, "real kimi contract")
  );
});
