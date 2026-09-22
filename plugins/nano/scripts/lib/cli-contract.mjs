// Single source of truth for the `kimi` CLI command surface this plugin depends on.
//
// The nano-companion shells out to the global `kimi` binary. If a future
// kimi-cli release renames or removes a subcommand or flag we rely on, the
// plugin breaks at runtime. This module encodes the required command surface
// and verifies it against `kimi --help` / `kimi <subcommand> --help` output.
//
// We verify against *help text* (the stable, documented contract) rather than
// actually executing tasks, so the check is fast, offline, and never requires
// authentication.
//
// IMPORTANT: kimi-cli renders help via Typer/Rich. The output contains ANSI
// color escape codes and Rich box-drawing characters, and option lines wrap at
// the terminal width. To match reliably we must (a) ask the CLI for plain, wide
// output (NO_COLOR=1, TERM=dumb, COLUMNS=200), (b) strip any ANSI escapes that
// leak through anyway, and (c) normalize whitespace before tokenizing. A naive
// substring/whitespace tokenizer on the raw, colored, narrow output produces
// false negatives (every flag glued to an escape code looks "missing").

/**
 * The authoritative manifest of the `kimi` command surface this plugin
 * requires. Each entry describes one help-text source we parse and the
 * tokens (subcommands / flags) that must appear in it.
 *
 * `argv` is what we pass to `kimi` to obtain the relevant help text:
 *   []                     -> `kimi --help`        (top-level help)
 *   ["login", "--help"]    -> `kimi login --help`  (subcommand help)
 *
 * `requires` is the list of tokens that must be present in that help text.
 * Each requirement is `{ token, kind, note }`:
 *   - token: the literal string to look for (flag like "--model" or a
 *            subcommand name like "info").
 *   - kind:  "flag" | "subcommand" (informational / for reporting).
 *   - note:  where in the plugin this is used (informational).
 *
 * Derived from plugins/nano/scripts/nano-companion.mjs:
 *   - getKimiAvailability(): `kimi --version`
 *   - getKimiAuthStatus():   `kimi info`, `kimi login --help`
 *   - buildKimiArgs():       `--quiet`, `--yolo`, `--model`, `--thinking`,
 *                            `--continue`, `-p` (used by task + review runs)
 */
export const REQUIRED_COMMANDS = [
  {
    id: "top-level",
    description: "kimi top-level help (subcommands + global run flags)",
    argv: ["--help"],
    requires: [
      { token: "--version", kind: "flag", note: "getKimiAvailability() runs `kimi --version`" },
      { token: "info", kind: "subcommand", note: "getKimiAuthStatus() runs `kimi info`" },
      { token: "login", kind: "subcommand", note: "getKimiAuthStatus() probes `kimi login --help`; setup suggests `!kimi login`" },
      { token: "--quiet", kind: "flag", note: "buildKimiArgs() always passes --quiet" },
      { token: "--yolo", kind: "flag", note: "buildKimiArgs() always passes --yolo" },
      { token: "--model", kind: "flag", note: "buildKimiArgs() passes --model <model> when set" },
      { token: "--thinking", kind: "flag", note: "buildKimiArgs() passes --thinking for tasks" },
      { token: "--continue", kind: "flag", note: "buildKimiArgs() passes --continue to resume" },
      { token: "-p", kind: "flag", note: "buildKimiArgs() passes -p <prompt> (print mode)" }
    ]
  },
  {
    id: "login",
    description: "kimi login --help (auth-status fallback probe)",
    argv: ["login", "--help"],
    // We only need `login` to be a real subcommand that responds to --help;
    // any non-empty help output that mentions login satisfies this.
    requires: [
      { token: "login", kind: "subcommand", note: "getKimiAuthStatus() probes `kimi login --help`" }
    ]
  }
];

/**
 * Environment overrides that force `kimi` (Typer/Rich) to emit plain, wide help
 * text: no ANSI color, a "dumb" terminal, and a wide column count so option
 * lines do not wrap mid-token. Callers that invoke the real binary should merge
 * this into the child process env. Exported so the test and the CI runner share
 * exactly one definition.
 */
export const HELP_ENV = Object.freeze({
  NO_COLOR: "1",
  // Some Rich/Typer code paths still colorize unless this is also set.
  TERM: "dumb",
  // Wide enough that no required option line wraps.
  COLUMNS: "200",
  // Belt-and-suspenders: make sure nothing forces color back on.
  FORCE_COLOR: "0"
});

/**
 * Remove ANSI escape sequences (CSI color codes, etc.) from a string. Typer/Rich
 * may emit these even when NO_COLOR is requested, and when glued to a flag (e.g.
 * "\x1b[1;36m--version\x1b[0m") they make the flag undiscoverable.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  // Matches CSI sequences like ESC[ ... <final-byte> and a few other escapes.
  // eslint-disable-next-line no-control-regex
  return String(text ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * Normalize help text into a flat, ANSI-free, single-spaced form. This collapses
 * the box-drawing layout and wrapped lines that Rich produces so that token
 * matching is stable regardless of terminal width or color settings.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeHelp(text) {
  return stripAnsi(text)
    // Drop Rich box-drawing characters so they don't fuse with tokens.
    .replace(/[─-╿]/g, " ")
    // Collapse all whitespace (including newlines) to single spaces.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize help text into a set of tokens, after stripping ANSI escapes and
 * normalizing whitespace. Splits on whitespace and the separators help
 * formatters use ("," "|" "/" parens/brackets) so individual flags and short
 * aliases are discoverable even when printed as "--prompt,--command -p,-c" or
 * "--thinking/--no-thinking".
 *
 * @param {string} helpText
 * @returns {Set<string>}
 */
export function tokenizeHelp(helpText) {
  const tokens = new Set();
  const text = normalizeHelp(helpText);
  // Split on whitespace and a few separators help formatters use.
  for (const raw of text.split(/[\s,|/()\[\]]+/)) {
    if (!raw) {
      continue;
    }
    // Drop trailing punctuation like "." or ":".
    const token = raw.replace(/[.:;]+$/, "");
    if (!token) {
      continue;
    }
    tokens.add(token);
    // For "--flag=VALUE" record the bare "--flag" too.
    const eq = token.indexOf("=");
    if (eq > 0) {
      tokens.add(token.slice(0, eq));
    }
  }
  return tokens;
}

/**
 * Check a single requirement against tokenized help text.
 *
 * A requirement is satisfied if its exact token appears as a standalone token
 * in the help output. We also accept a small set of documented equivalences so
 * a help formatter that prints e.g. `-p, --print` still satisfies `-p`.
 *
 * @param {{token: string, kind: string}} requirement
 * @param {Set<string>} tokens
 * @returns {boolean}
 */
function requirementSatisfied(requirement, tokens) {
  if (tokens.has(requirement.token)) {
    return true;
  }
  // Documented equivalences: the plugin passes the short/long forms below,
  // but kimi help may list the alternate spelling. Both forms are accepted
  // because kimi-cli treats them as aliases for the same flag. (Verified against
  // kimi-cli source: `--prompt/-p/--command/-c`, `--continue/-C`, `--model/-m`,
  // `--version/-V` are all aliases of one option.)
  const equivalents = {
    "-p": ["--prompt", "--command", "-c"],
    "--continue": ["-C"],
    "--model": ["-m"],
    "--version": ["-V"]
  };
  const alts = equivalents[requirement.token];
  if (alts) {
    return alts.some((alt) => tokens.has(alt));
  }
  return false;
}

/**
 * Verify the full manifest against help text supplied by `fetchHelp`.
 *
 * @param {(argv: string[]) => string} fetchHelp
 *   Synchronous function that, given an argv (e.g. ["--help"] or
 *   ["login", "--help"]), returns the corresponding `kimi` help text. It may
 *   return an empty string if the help could not be obtained.
 * @param {object} [options]
 * @param {Array} [options.manifest] Override the manifest (defaults to REQUIRED_COMMANDS).
 * @returns {{ ok: boolean, results: Array, missing: Array }}
 *   `results` has one entry per manifest group with per-requirement status.
 *   `missing` is a flat list of unsatisfied requirements (with group id).
 */
export function verifyContract(fetchHelp, options = {}) {
  const manifest = options.manifest ?? REQUIRED_COMMANDS;
  const results = [];
  const missing = [];

  for (const group of manifest) {
    let helpText = "";
    let fetchError = null;
    try {
      helpText = fetchHelp(group.argv) ?? "";
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }

    const tokens = tokenizeHelp(helpText);
    const checks = group.requires.map((requirement) => {
      const satisfied = !fetchError && requirementSatisfied(requirement, tokens);
      if (!satisfied) {
        missing.push({
          group: group.id,
          token: requirement.token,
          kind: requirement.kind,
          note: requirement.note,
          reason: fetchError ? `help fetch failed: ${fetchError}` : "token not found in help text"
        });
      }
      return { ...requirement, satisfied };
    });

    results.push({
      id: group.id,
      description: group.description,
      argv: group.argv,
      fetchError,
      helpEmpty: !helpText.trim(),
      checks
    });
  }

  return {
    ok: missing.length === 0,
    results,
    missing
  };
}

/**
 * Build a human-readable report from a verifyContract() result.
 *
 * @param {{ ok: boolean, results: Array, missing: Array }} verification
 * @param {string} [label]
 * @returns {string}
 */
export function formatContractReport(verification, label = "kimi CLI contract") {
  const lines = [];
  const status = verification.ok ? "OK" : "FAILED";
  lines.push(`${label}: ${status}`);
  for (const group of verification.results) {
    lines.push(`  [${group.id}] kimi ${group.argv.join(" ")}`);
    if (group.fetchError) {
      lines.push(`    ! could not fetch help: ${group.fetchError}`);
    }
    for (const check of group.checks) {
      const mark = check.satisfied ? "ok" : "MISSING";
      lines.push(`    - ${check.token} (${check.kind}): ${mark}`);
    }
  }
  if (!verification.ok) {
    lines.push("");
    lines.push("Missing required command surface:");
    for (const item of verification.missing) {
      lines.push(`  - [${item.group}] ${item.token} (${item.kind}) -> ${item.reason}`);
      lines.push(`      used by: ${item.note}`);
    }
  }
  return lines.join("\n");
}
