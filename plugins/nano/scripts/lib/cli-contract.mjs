// Single source of truth for the `claude` (Claude Code) CLI command surface
// this plugin depends on.
//
// The nano-companion shells out to the global `claude` binary running headless
// against NanoGPT:
//
//   claude --version
//   claude -p --restricted --strict-mcp-config --model <m>
//        --tools=<list> --permission-mode dontAsk
//        --allowedTools=<list> --output-format json|stream-json
//        [--verbose] [--resume <id>] -- <prompt>
//
// If a future Claude Code release renames or removes a flag we rely on, the
// plugin breaks at runtime. This module encodes the required command surface
// and verifies it against `claude --help` output.
//
// We verify against *help text* (the stable, documented contract) rather than
// actually executing tasks, so the check is fast, offline, and never requires
// authentication.
//
// Claude Code renders help via commander. The output is plain text (no
// box-drawing), but commander still wraps long option lines at the terminal
// width, and it can emit ANSI color codes when a TTY is attached. To match
// reliably we must (a) ask the CLI for plain, wide output (NO_COLOR=1,
// TERM=dumb, COLUMNS=200), (b) strip any ANSI escapes that leak through
// anyway, and (c) normalize whitespace before tokenizing. A naive
// substring/whitespace tokenizer on raw, colored, narrow output produces false
// negatives (every flag glued to an escape code, or a flag split across two
// wrapped lines, looks "missing").

/**
 * The authoritative manifest of the `claude` command surface this plugin
 * requires. Each entry describes one help-text source we parse and the
 * tokens (flags / flag values) that must appear in it.
 *
 * `argv` is what we pass to `claude` to obtain the relevant help text:
 *   ["--help"]  -> `claude --help`  (top-level help; all our flags are global)
 *
 * `requires` is the list of tokens that must be present in that help text.
 * Each requirement is `{ token, kind, note }`:
 *   - token: the literal string to look for (a flag like "--model", or a flag
 *            value like "dontAsk").
 *   - kind:  "flag" | "choice" (informational / for reporting). "choice" marks
 *            a value that must appear inside a `(choices: ...)` list.
 *   - note:  where in the plugin this is used (informational).
 *
 * Derived from plugins/nano/scripts/lib/runtime.mjs:
 *   - getClaudeAvailability(): `claude --version`
 *   - buildClaudeArgs():       `-p`, `--restricted`, `--strict-mcp-config`,
 *                              `--model`, `--tools`, `--permission-mode
 *                              dontAsk`, `--allowedTools`, `--output-format
 *                              json|stream-json`, `--verbose` (with
 *                              stream-json), `--resume`.
 */
export const REQUIRED_COMMANDS = [
  {
    id: "top-level",
    description: "claude top-level help (global flags used by buildClaudeArgs)",
    argv: ["--help"],
    requires: [
      { token: "--version", kind: "flag", note: "getClaudeAvailability() runs `claude --version`" },
      { token: "-p", kind: "flag", note: "buildClaudeArgs() always passes -p (print/headless mode)" },
      { token: "--restricted", kind: "flag", note: "buildClaudeArgs() always passes --restricted" },
      { token: "--strict-mcp-config", kind: "flag", note: "buildClaudeArgs() always passes --strict-mcp-config" },
      { token: "--tools", kind: "flag", note: "buildClaudeArgs() passes --tools=<list>" },
      { token: "--permission-mode", kind: "flag", note: "buildClaudeArgs() passes --permission-mode dontAsk" },
      { token: "dontAsk", kind: "choice", note: "buildClaudeArgs() sets --permission-mode to dontAsk" },
      { token: "--allowedTools", kind: "flag", note: "buildClaudeArgs() passes --allowedTools=<list>" },
      { token: "--output-format", kind: "flag", note: "buildClaudeArgs() passes --output-format json|stream-json" },
      { token: "stream-json", kind: "choice", note: "buildClaudeArgs() uses --output-format stream-json for streamed runs" },
      { token: "--verbose", kind: "flag", note: "buildClaudeArgs() passes --verbose with stream-json" },
      { token: "--resume", kind: "flag", note: "buildClaudeArgs() passes --resume <id> to resume a session" },
      { token: "--model", kind: "flag", note: "buildClaudeArgs() passes --model <model>" }
    ]
  }
];

/**
 * Environment overrides that force `claude` (commander) to emit plain, wide
 * help text: no ANSI color, a "dumb" terminal, and a wide column count so
 * option lines do not wrap mid-token. Callers that invoke the real binary
 * should merge this into the child process env. Exported so the test and the
 * CI runner share exactly one definition.
 */
export const HELP_ENV = Object.freeze({
  NO_COLOR: "1",
  // Commander checks TERM/TTY; a dumb terminal discourages color.
  TERM: "dumb",
  // Wide enough that no required option line wraps mid-token.
  COLUMNS: "200",
  // Belt-and-suspenders: make sure nothing forces color back on.
  FORCE_COLOR: "0"
});

/**
 * Flags the plugin depends on that are hidden from `claude --help`, so the
 * help-text contract above cannot see them. They are probed by execution
 * instead: `claude -p <flag> 1 ... -- ping` against an unreachable offline
 * endpoint. A flag that the installed claude no longer knows fails commander
 * argument parsing with `error: unknown option '<flag>'` on stderr; any other
 * failure (network, auth) is fine, because it means the flag was accepted.
 */
export const HIDDEN_FLAGS = Object.freeze([
  { flag: "--max-turns", note: "buildClaudeArgs() passes --max-turns <n> (turn cap; hidden from --help)" }
]);

/**
 * The argv used to probe one hidden flag: a minimal headless run with a tiny
 * turn cap against a prompt of "ping".
 */
export function buildHiddenFlagProbeArgv(flag) {
  return ["-p", flag, "1", "--output-format", "json", "--tools=Read", "--", "ping"];
}

/**
 * Environment for the hidden-flag probe: HELP_ENV plus an unreachable base
 * URL and a non-key so the probe is offline and fast (3s API timeout, no
 * retries). ANTHROPIC_AUTH_TOKEN is removed so a host token cannot route the
 * probe somewhere real.
 */
export function hiddenFlagProbeEnv(baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ...HELP_ENV,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_API_KEY: "contract-probe-not-a-key",
    API_TIMEOUT_MS: "3000",
    CLAUDE_CODE_MAX_RETRIES: "0"
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * Verify the hidden flags by execution. `runProbe(flag)` runs
 * buildHiddenFlagProbeArgv(flag) against the real (or fake) claude and returns
 * `{ status, stdout, stderr }`; it may throw. A flag fails when the probe's
 * stderr matches /unknown option/ (commander rejected the flag) or the probe
 * itself could not run.
 *
 * @returns {{ ok: boolean, checks: Array, missing: Array }}
 */
export function verifyHiddenFlags(runProbe, options = {}) {
  const flags = options.flags ?? HIDDEN_FLAGS;
  const checks = [];
  const missing = [];

  for (const entry of flags) {
    let stderr = "";
    let probeError = null;
    try {
      const result = runProbe(entry.flag) ?? {};
      stderr = String(result.stderr ?? "");
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }

    const satisfied = !probeError && !/unknown option/.test(stderr);
    if (!satisfied) {
      missing.push({
        flag: entry.flag,
        note: entry.note,
        reason: probeError ? `probe failed: ${probeError}` : `claude rejected the flag: ${stderr.trim().split("\n", 1)[0]}`
      });
    }
    checks.push({ flag: entry.flag, note: entry.note, satisfied, probeError });
  }

  return { ok: missing.length === 0, checks, missing };
}

/**
 * Build a human-readable report from a verifyHiddenFlags() result.
 */
export function formatHiddenFlagsReport(verification, label = "claude hidden flags") {
  const lines = [];
  const status = verification.ok ? "OK" : "FAILED";
  lines.push(`${label}: ${status}`);
  for (const check of verification.checks) {
    const mark = check.satisfied ? "ok" : "MISSING";
    lines.push(`  - ${check.flag}: ${mark}`);
  }
  if (!verification.ok) {
    lines.push("");
    lines.push("Rejected hidden flags:");
    for (const item of verification.missing) {
      lines.push(`  - ${item.flag} -> ${item.reason}`);
      lines.push(`      used by: ${item.note}`);
    }
  }
  return lines.join("\n");
}

/**
 * Remove ANSI escape sequences (CSI color codes, etc.) from a string.
 * Commander may emit these even when NO_COLOR is requested (e.g. when run
 * under a force-color shim), and when glued to a flag (e.g.
 * "\x1b[1m--version\x1b[0m") they make the flag undiscoverable.
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
 * Normalize help text into a flat, ANSI-free, single-spaced form. This
 * collapses the wrapped lines that commander produces so that token matching
 * is stable regardless of terminal width or color settings.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeHelp(text) {
  return stripAnsi(text)
    // Collapse all whitespace (including newlines) to single spaces so a
    // flag split across two wrapped lines is still discoverable.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize help text into a set of tokens, after stripping ANSI escapes and
 * normalizing whitespace. Splits on whitespace and the separators commander
 * uses ("," "|" "/" parens/brackets, and the surrounding quotes around choice
 * values) so individual flags, short aliases, and choice values are all
 * discoverable even when printed as "-p, --print" or
 * `(choices: "acceptEdits", "dontAsk", "plan")`.
 *
 * @param {string} helpText
 * @returns {Set<string>}
 */
export function tokenizeHelp(helpText) {
  const tokens = new Set();
  const text = normalizeHelp(helpText);
  // Split on whitespace, list separators, and wrapping/quote characters.
  for (const raw of text.split(/[\s,|/()\[\]"']+/)) {
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
 * a help line that prints e.g. `-p, --print` still satisfies `-p`, and one
 * that prints `--allowedTools, --allowed-tools` still satisfies
 * `--allowedTools`. Both forms are accepted because commander treats them as
 * aliases for the same flag.
 *
 * @param {{token: string, kind: string}} requirement
 * @param {Set<string>} tokens
 * @returns {boolean}
 */
function requirementSatisfied(requirement, tokens) {
  if (tokens.has(requirement.token)) {
    return true;
  }
  // Documented equivalences: the plugin passes the forms on the left, but
  // claude --help may list the alternate spelling. Verified against the
  // commander option definitions in Claude Code:
  //   -p            also "--print"
  //   --allowedTools also "--allowed-tools"
  //   --resume       also "-r"
  //   --version      also "-v"
  const equivalents = {
    "-p": ["--print"],
    "--allowedTools": ["--allowed-tools"],
    "--resume": ["-r"],
    "--version": ["-v"]
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
 *   Synchronous function that, given an argv (e.g. ["--help"]), returns the
 *   corresponding `claude` help text. It may return an empty string if the
 *   help could not be obtained.
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
export function formatContractReport(verification, label = "claude CLI contract") {
  const lines = [];
  const status = verification.ok ? "OK" : "FAILED";
  lines.push(`${label}: ${status}`);
  for (const group of verification.results) {
    lines.push(`  [${group.id}] claude ${group.argv.join(" ")}`);
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
