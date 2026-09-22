#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  pingNanoGpt,
  fetchSubscriptionUsage,
  describeSubscription,
  buildRunQuota
} from "./lib/account.mjs";
import {
  loadModelCatalog,
  resolveModelSelection,
  describeAliases,
  DEFAULT_MODEL
} from "./lib/models.mjs";
import { verifyContract, HELP_ENV, REQUIRED_COMMANDS } from "./lib/cli-contract.mjs";
import { runCommand } from "./lib/process.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendRunLog,
  buildChildEnv,
  buildClaudeArgs,
  buildPermissionProfile,
  buildRunLogEntry,
  compareVersions,
  DEFAULT_BASH_ALLOW,
  DEFAULT_REVIEW_MAX_TURNS,
  DEFAULT_TASK_MAX_TURNS,
  getClaudeAvailability,
  isMaxTurnsStop,
  isToolUseProgressLine,
  KEY_SETUP_COMMAND,
  MIN_CLAUDE_VERSION,
  normalizeBashAllow,
  normalizeMaxTurns,
  parseClaudeJsonOutput,
  parseStreamEvent,
  parseClaudeVersion,
  requireApiKey,
  resolveApiKey,
  resolveBaseUrl,
  resolveMaxInlineChars,
  runClaude,
  shouldSendPromptViaStdin,
  summarizeClaudeResult
} from "./lib/runtime.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  JOB_ORIGIN_ENV,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV,
  STOP_GATE_ORIGIN
} from "./lib/tracked-jobs.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderRunFooter,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskRun,
  maxTurnsStopMessage
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

// Emits each selection warning to stderr (so it surfaces interactively) and
// returns the resolved model id plus the warnings, so callers can attach them
// to task/review payloads and rendered output.
function emitWarnings(warnings) {
  for (const text of warnings) {
    process.stderr.write(`[nano] warning: ${text}\n`);
  }
}

/**
 * Resolve a run model against the NanoGPT catalog. With no API key the builtin
 * catalog is used (offline). A thrown selection error (paid/unknown model)
 * propagates to the caller, which fails the command with exit 1.
 *
 * Returns `{ model, warnings }`. Callers are responsible for calling
 * emitWarnings and attaching warnings to the payload.
 */
async function resolveRunModel({ requested, config, thinking = false, allowPaid = false } = {}) {
  const { key: apiKey } = resolveApiKey();
  const catalog = await loadModelCatalog({
    apiKey,
    baseUrl: resolveBaseUrl(),
    env: process.env
  });
  return resolveModelSelection({
    requested,
    configModel: config?.model,
    thinking,
    allowPaid,
    catalog
  });
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/nano-companion.mjs setup [--json]",
      "  node scripts/nano-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--max-turns <n>]",
      "  node scripts/nano-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--max-turns <n>] [focus text]",
      "  node scripts/nano-companion.mjs task [--background] [--continue] [--model <model>] [--thinking] [--read-only] [--allow-bash <prefix>] [--allow-paid] [--max-turns <n>] [prompt]",
      "  node scripts/nano-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/nano-companion.mjs result [job-id] [--json]",
      "  node scripts/nano-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

// ---------------------------------------------------------------------------
// claude availability / setup
// ---------------------------------------------------------------------------

function ensureClaudeAvailable(cwd) {
  const availability = getClaudeAvailability(cwd);
  if (!availability.available) {
    throw new Error("Claude Code is not installed or not on PATH. Install it, then rerun `/nano:setup`.");
  }
}

// Force plain, wide help output so commander doesn't wrap/colorize, mirroring
// check-cli-contract.mjs.
const SETUP_HELP_ENV = { ...process.env, ...HELP_ENV };

function fetchHelpForContract(argv) {
  const result = runCommand("claude", argv, {
    maxBuffer: 10 * 1024 * 1024,
    env: SETUP_HELP_ENV
  });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/**
 * Detect a project test command for the setup next-steps suggestion.
 * Returns `{ command, prefix }` where `command` is the full
 * suggested `/nano:setup --allow-bash ...` / `just test` / `cargo test` and
 * `prefix` is the Bash allowlist prefix it would add (so callers can skip the
 * suggestion when the prefix is already allowlisted), or null.
 */
function detectTestCommandSuggestion(workspaceRoot, effectiveBashAllow) {
  const hasPackageJson = fs.existsSync(path.join(workspaceRoot, "package.json"));
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
      if (pkg && typeof pkg.scripts === "object" && typeof pkg.scripts.test === "string") {
        if (effectiveBashAllow.includes("npm test")) {
          return null;
        }
        return { command: '/nano:setup --allow-bash "npm test"', prefix: "npm test" };
      }
    } catch {
      // malformed package.json: fall through
    }
  }

  for (const name of ["justfile", "Justfile"]) {
    const file = path.join(workspaceRoot, name);
    if (fs.existsSync(file)) {
      try {
        const text = fs.readFileSync(file, "utf8");
        if (/^\s*test\b/m.test(text)) {
          if (effectiveBashAllow.includes("just test")) {
            return null;
          }
          return { command: "just test", prefix: "just test" };
        }
      } catch {
        // ignore
      }
    }
  }

  if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) {
    if (effectiveBashAllow.includes("cargo test")) {
      return null;
    }
    return { command: "cargo test", prefix: "cargo test" };
  }

  return null;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const reviewGateEnabled = Boolean(config.stopReviewGate);
  const { key: apiKey, source: apiKeySource } = resolveApiKey();
  const baseUrl = resolveBaseUrl();

  const claudeAvailability = getClaudeAvailability(cwd);
  const claudeVersion = claudeAvailability.available ? parseClaudeVersion(claudeAvailability.detail) : null;

  // Check 1: node version
  const nodeOk = compareVersions(process.versions.node, "18.18.0") >= 0;
  const nodeCheck = {
    id: "node",
    label: "Node",
    ok: nodeOk,
    detail: `Node ${process.versions.node}`
  };

  // Check 2: claude on PATH and version >= MIN_CLAUDE_VERSION
  let claudeCheckOk = false;
  let claudeCheckDetail;
  if (!claudeAvailability.available) {
    claudeCheckDetail = "not found";
  } else if (!claudeVersion) {
    claudeCheckDetail = `unparseable version: ${claudeAvailability.detail}`;
  } else if (compareVersions(claudeVersion, MIN_CLAUDE_VERSION) < 0) {
    claudeCheckDetail = `claude ${claudeVersion} is older than the required ${MIN_CLAUDE_VERSION}`;
  } else {
    claudeCheckOk = true;
    claudeCheckDetail = `claude ${claudeVersion}`;
  }
  const claudeCheck = {
    id: "claude",
    label: "Claude Code",
    ok: claudeCheckOk,
    detail: claudeCheckDetail
  };

  // Check 3: CLI contract (only when claude is present)
  let contractOk = false;
  let contractDetail;
  if (!claudeAvailability.available) {
    contractDetail = "skipped: claude not found";
  } else {
    try {
      const verification = verifyContract(fetchHelpForContract, { manifest: REQUIRED_COMMANDS });
      contractOk = verification.ok;
      if (verification.ok) {
        contractDetail = "CLI contract satisfied";
      } else {
        const missing = verification.missing.map((m) => m.token).join(", ");
        contractDetail = `missing: ${missing}`;
      }
    } catch (error) {
      contractDetail = `contract check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const contractCheck = {
    id: "contract",
    label: "CLI contract",
    ok: contractOk,
    detail: contractDetail
  };

  // Check 4: API key resolves (report the SOURCE only, never the value)
  const apiKeyOk = Boolean(apiKey);
  const apiKeyCheck = {
    id: "apiKey",
    label: "API key",
    ok: apiKeyOk,
    detail: apiKeyOk ? apiKeySource : "not found"
  };

  const pingModel = config.model || DEFAULT_MODEL;

  // Check 5: pingNanoGpt (only when a key resolves)
  let pingOk = false;
  let pingDetail;
  if (!apiKey) {
    pingDetail = "skipped: no API key";
  } else {
    const ping = await pingNanoGpt({ apiKey, baseUrl, model: pingModel });
    pingOk = ping.ok;
    pingDetail = `${pingModel}: ${ping.detail}`;
  }
  const pingCheck = {
    id: "ping",
    label: "NanoGPT ping",
    ok: pingOk,
    detail: pingDetail
  };

  // Check 6: subscription active with remaining quota
  let subscriptionOk = false;
  let subscriptionDetail;
  if (!apiKey) {
    subscriptionDetail = "skipped: no API key";
  } else {
    const usage = await fetchSubscriptionUsage({ apiKey, baseUrl });
    if (!usage.ok) {
      subscriptionOk = false;
      subscriptionDetail = describeSubscription(usage);
    } else if (usage.active !== true) {
      subscriptionOk = false;
      subscriptionDetail = describeSubscription(usage);
    } else if (usage.weeklyRemaining !== null && usage.weeklyRemaining <= 0) {
      subscriptionOk = false;
      subscriptionDetail = describeSubscription(usage);
    } else {
      subscriptionOk = true;
      subscriptionDetail = describeSubscription(usage);
    }
  }
  const subscriptionCheck = {
    id: "subscription",
    label: "Subscription",
    ok: subscriptionOk,
    detail: subscriptionDetail
  };

  const checks = [nodeCheck, claudeCheck, contractCheck, apiKeyCheck, pingCheck, subscriptionCheck];
  const ready = checks.every((check) => check.ok);

  // Load the catalog so we can report its source. With no key the builtin
  // catalog is used (offline). The catalog fetch fails fast against the
  // unreachable test base URL; nothing waits on a long timeout.
  const catalog = await loadModelCatalog({ apiKey, baseUrl, env: process.env });

  const defaultModel = config.model || DEFAULT_MODEL;
  const aliases = describeAliases();
  const bashAllow = normalizeBashAllow([...DEFAULT_BASH_ALLOW, ...(config.bashAllow ?? [])]);

  // Build next-steps.
  const nextSteps = [];
  if (!claudeAvailability.available || (claudeVersion && compareVersions(claudeVersion, MIN_CLAUDE_VERSION) < 0)) {
    nextSteps.push(`Install or upgrade Claude Code to >= ${MIN_CLAUDE_VERSION} (https://claude.com/claude-code), then rerun /nano:setup.`);
  }
  if (!apiKey) {
    // Exactly the keychain command; it prompts for the key so it never lands
    // in shell history. Never suggest .env files or plaintext config.
    nextSteps.push(`${KEY_SETUP_COMMAND} (prompts for the key so it never lands in shell history)`);
  }
  if (apiKey && (!pingOk || !subscriptionOk)) {
    nextSteps.push("Check the NanoGPT subscription and API key, then rerun /nano:setup.");
  }
  const testSuggestion = detectTestCommandSuggestion(workspaceRoot, bashAllow);
  if (testSuggestion) {
    nextSteps.push(
      `Allow the project test command: ${testSuggestion.command} (risk: NanoGPT can then run any code it writes into the tests or build files)`
    );
  }

  return {
    ready,
    checks,
    defaultModel,
    aliases,
    bashAllow,
    catalogSource: catalog.source,
    reviewGateEnabled,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "model"],
    multiValueOptions: ["allow-bash", "disallow-bash"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = getConfig(workspaceRoot);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  // --model: validate against the catalog (allowPaid false, thinking false)
  // and store the resolved id.
  if (options.model) {
    const { key: modelApiKey } = resolveApiKey();
    const modelCatalog = await loadModelCatalog({
      apiKey: modelApiKey,
      baseUrl: resolveBaseUrl(),
      env: process.env
    });
    // Throws on paid/unknown model; the companion's top-level catch turns
    // that into exit 1 with the message.
    const { model: resolvedModel } = resolveModelSelection({
      requested: options.model,
      configModel: config.model,
      thinking: false,
      allowPaid: false,
      catalog: modelCatalog
    });
    setConfig(workspaceRoot, "model", resolvedModel);
    actionsTaken.push(`Set default model to ${resolvedModel}.`);
  }

  // --allow-bash <prefix> (repeatable): merge into config.bashAllow.
  if (options["allow-bash"]) {
    const newPrefixes = options["allow-bash"];
    const merged = normalizeBashAllow([...(config.bashAllow ?? []), ...newPrefixes]);
    setConfig(workspaceRoot, "bashAllow", merged);
    for (const prefix of newPrefixes) {
      actionsTaken.push(`Allowed Bash prefix: ${prefix}`);
    }
  }

  // --disallow-bash <prefix> (repeatable): remove from config.bashAllow.
  if (options["disallow-bash"]) {
    const currentConfig = getConfig(workspaceRoot);
    let currentList = Array.isArray(currentConfig.bashAllow) ? currentConfig.bashAllow : [];
    for (const rawPrefix of options["disallow-bash"]) {
      const [normalized] = normalizeBashAllow([rawPrefix]);
      const prefix = normalized ?? String(rawPrefix).trim();
      if (DEFAULT_BASH_ALLOW.includes(prefix)) {
        actionsTaken.push(`Bash prefix "${prefix}" is a built-in default and cannot be removed (it stays).`);
        continue;
      }
      if (!currentList.includes(prefix)) {
        actionsTaken.push(`Bash prefix "${prefix}" was not present in the allowlist.`);
        continue;
      }
      currentList = currentList.filter((p) => p !== prefix);
      setConfig(workspaceRoot, "bashAllow", currentList);
      actionsTaken.push(`Removed Bash prefix: ${prefix}`);
    }
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// ---------------------------------------------------------------------------
// shared executor: spawn `claude -p` against NanoGPT and collect the result
// ---------------------------------------------------------------------------

/**
 * request = { cwd, prompt, model, profile ("read"|"write"), bashAllow,
 *   resumeSessionId, streaming, onProgress, onSession, maxTurns }
 *
 * The permission profile is always rebuilt here from its name and the Bash
 * allowlist (validated by normalizeBashAllow); a ready-made tools/allowedTools
 * object, e.g. from a tampered job file, is rejected.
 *
 * The API key is resolved fresh here (never taken from `request`), so a
 * queued background job's stored request never contains it. Returns
 * `{ exitStatus, summary (null if no JSON), permissions, model, quota,
 * stderr, stdout }`. `exitStatus` is 0 only if the process exited 0 AND the
 * stdout parsed as JSON AND `summary.isError` is false.
 *
 * `quota` is built from subscription usage snapshots taken just before and
 * just after the run (see buildRunQuota). A failed or slow usage fetch never
 * fails the run: `quota` is null when the after-snapshot failed.
 *
 * With `streaming` the run uses `--output-format stream-json --verbose` and
 * each stdout line is fed to parseStreamEvent: progress strings are passed to
 * `onProgress` (so they land in the job log) and the first session id seen is
 * passed to `onSession` and returned as `streamSessionId`. The final summary
 * still comes from the last `type: "result"` line via parseClaudeJsonOutput.
 */
async function executeClaudeRun({
  cwd,
  prompt,
  model,
  profile,
  bashAllow,
  resumeSessionId = null,
  streaming = false,
  onProgress = null,
  onSession = null,
  maxTurns = null
}) {
  if (typeof profile !== "string") {
    throw new Error('Invalid permission profile: expected "read" or "write".');
  }
  if (bashAllow != null && !Array.isArray(bashAllow)) {
    throw new Error("Invalid Bash allowlist: expected a list of command prefixes.");
  }
  const permissions = buildPermissionProfile(profile, { bashAllow });

  const { key: apiKey } = requireApiKey();
  const baseUrl = resolveBaseUrl();
  const env = buildChildEnv({ apiKey, model, baseUrl });
  const promptViaStdin = shouldSendPromptViaStdin(prompt);
  const args = buildClaudeArgs({
    prompt,
    model,
    profile: permissions,
    resumeSessionId,
    outputFormat: streaming ? "stream-json" : "json",
    promptViaStdin,
    maxTurns
  });

  if (typeof onProgress === "function") {
    onProgress(`Running NanoGPT (${model}, profile=${permissions.name})...`);
  }

  let streamSessionId = null;
  const onStdoutLine = streaming
    ? (line) => {
        const event = parseStreamEvent(line, { cwd });
        if (!event) {
          return;
        }
        if (event.sessionId && !streamSessionId) {
          streamSessionId = event.sessionId;
          if (typeof onSession === "function") {
            onSession(event.sessionId);
          }
        }
        for (const text of event.progress) {
          if (typeof onProgress === "function") {
            onProgress(text);
          }
        }
      }
    : null;

  // Quota snapshots around the run. fetchSubscriptionUsage never throws, but
  // guard anyway: a quota read must never fail the run.
  const fetchUsage = async () => {
    try {
      return await fetchSubscriptionUsage({ apiKey, baseUrl, timeoutMs: 5000 });
    } catch {
      return null;
    }
  };
  const usageBefore = await fetchUsage();

  const result = await runClaude({
    cwd,
    args,
    env,
    input: promptViaStdin ? prompt : null,
    onStdoutLine
  });

  const usageAfter = await fetchUsage();
  const quota = buildRunQuota(usageBefore, usageAfter);

  const parsed = parseClaudeJsonOutput(result.stdout);
  const summary = parsed ? summarizeClaudeResult(parsed) : null;
  const exitStatus = result.status === 0 && summary && summary.isError === false ? 0 : (result.status || 1);

  appendRunLog(
    buildRunLogEntry({
      model,
      cwd,
      allowedTools: permissions.allowedTools,
      task: prompt,
      quotaDelta: quota?.delta ?? null,
      summary: summary ?? {
        isError: true,
        numTurns: null,
        usage: {},
        durationMs: null,
        permissionDenials: [],
        sessionId: null
      }
    })
  );

  return {
    exitStatus,
    summary,
    streamSessionId,
    permissions,
    model,
    quota,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

function buildReviewPrompt(context, focusText, adversarial = false) {
  if (adversarial) {
    const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
    return interpolateTemplate(template, {
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_INPUT: context.content
    });
  }

  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    REVIEW_INPUT: context.content
  });
}

// Reviews always run the `read` permission profile: review is genuinely
// read-only, unlike a rescue `task` run.
async function executeReviewRun(request) {
  ensureClaudeAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName === "Adversarial Review");

  const run = await executeClaudeRun({
    cwd: request.cwd,
    prompt,
    model: request.model,
    profile: "read",
    maxTurns: request.maxTurns ?? null,
    onProgress: request.onProgress
  });

  const maxTurns = request.maxTurns ?? null;
  const stoppedAtMaxTurns = isMaxTurnsStop(run.summary);
  const warnings = Array.isArray(request.warnings) ? request.warnings : [];
  const rendered = renderReviewResult({
    reviewLabel: reviewName,
    targetLabel: context.target.label,
    summary: run.summary,
    model: run.model,
    stdout: run.stdout,
    stderr: run.stderr,
    warnings,
    quota: run.quota,
    maxTurns
  });

  const payload = {
    review: reviewName,
    target,
    status: run.exitStatus,
    isError: run.summary ? run.summary.isError : true,
    text: run.summary ? run.summary.text : "",
    claudeSessionId: run.summary?.sessionId ?? null,
    model: run.model,
    usage: run.summary?.usage ?? {},
    permissionDenials: run.summary?.permissionDenials ?? [],
    numTurns: run.summary?.numTurns ?? null,
    durationMs: run.summary?.durationMs ?? null,
    quota: run.quota ?? null,
    stopReason: stoppedAtMaxTurns ? "max_turns" : null,
    maxTurns,
    stderr: run.stderr,
    warnings,
    footer: renderRunFooter({ model: run.model, summary: run.summary, quota: run.quota })
  };

  return {
    exitStatus: run.exitStatus,
    payload,
    rendered,
    summary: stoppedAtMaxTurns
      ? maxTurnsStopMessage(maxTurns, { canContinue: false })
      : run.summary
        ? firstMeaningfulLine(run.summary.text, `${reviewName} completed.`)
        : firstMeaningfulLine(run.stderr || run.stdout, `${reviewName} did not return a result.`),
    jobTitle: `NanoGPT ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

async function executeTaskRun(request) {
  ensureClaudeAvailable(request.cwd);

  const prompt = request.prompt || "Continue from where you left off.";
  const maxTurns = request.maxTurns ?? null;

  const run = await executeClaudeRun({
    cwd: request.cwd,
    prompt,
    model: request.model,
    profile: request.profile,
    bashAllow: request.bashAllow,
    resumeSessionId: request.resumeSessionId ?? null,
    streaming: request.streaming ?? false,
    maxTurns,
    onProgress: request.onProgress,
    onSession: request.onSession
  });

  const stoppedAtMaxTurns = isMaxTurnsStop(run.summary);
  const warnings = Array.isArray(request.warnings) ? request.warnings : [];
  const { rendered, footer } = renderTaskRun({
    summary: run.summary,
    model: run.model,
    jobId: request.jobId ?? null,
    maxChars: resolveMaxInlineChars(),
    stdout: run.stdout,
    stderr: run.stderr,
    warnings,
    quota: run.quota,
    maxTurns
  });

  const payload = {
    status: run.exitStatus,
    isError: run.summary ? run.summary.isError : true,
    rawOutput: run.summary ? run.summary.text : "",
    // A run that died after its stream reported a session (no result object)
    // is still resumable; keep that id rather than null.
    claudeSessionId: run.summary?.sessionId ?? run.streamSessionId ?? null,
    model: run.model,
    profile: run.permissions.name,
    bashAllow: run.permissions.bashAllow,
    usage: run.summary?.usage ?? {},
    permissionDenials: run.summary?.permissionDenials ?? [],
    numTurns: run.summary?.numTurns ?? null,
    durationMs: run.summary?.durationMs ?? null,
    quota: run.quota ?? null,
    stopReason: stoppedAtMaxTurns ? "max_turns" : null,
    maxTurns,
    stderr: run.stderr,
    warnings,
    footer
  };

  const summary = stoppedAtMaxTurns
    ? maxTurnsStopMessage(maxTurns, { canContinue: true })
    : run.summary
      ? firstMeaningfulLine(run.summary.text, run.summary.isError ? "NanoGPT run failed." : "Task finished.")
      : firstMeaningfulLine(run.stderr || run.stdout, "NanoGPT did not return a result.");

  return {
    exitStatus: run.exitStatus,
    payload,
    rendered,
    summary,
    jobTitle: request.jobTitle ?? null,
    jobClass: "task",
    write: run.permissions.name === "write",
    jobPatch: {
      // Never overwrite a session id recorded earlier (worker onSession) with null.
      ...(payload.claudeSessionId ? { claudeSessionId: payload.claudeSessionId } : {}),
      model: run.model,
      profile: run.permissions.name,
      bashAllow: run.permissions.bashAllow,
      cwd: request.cwd
    }
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "NanoGPT Review" : `NanoGPT ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, continueSession = false }) {
  const title = continueSession ? "NanoGPT Continue" : "NanoGPT Task";
  const fallbackSummary = continueSession ? "Continue previous session" : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /nano:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, origin = null) {
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
  return origin ? { ...job, origin } : job;
}

function buildTaskRequest({ cwd, model, prompt, profile, bashAllow, resumeSessionId, jobId, warnings, maxTurns }) {
  return {
    cwd,
    model,
    prompt,
    profile,
    bashAllow,
    resumeSessionId,
    jobId,
    maxTurns,
    warnings: Array.isArray(warnings) ? warnings : []
  };
}

function readTaskPrompt(cwd, options, positionals) {
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "nano-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Write the job file and index record *before* spawning the worker. The
  // worker's first act is to read this same job file by id (handleTaskWorker
  // -> readStoredJob); spawning first raced the worker's read against this
  // write and could start it before the job existed on disk at all ("No
  // stored job found"). No pid yet: the worker isn't running until spawn
  // below returns. Only after that succeeds do we patch the index with its
  // pid - a minimal `{ id, pid }` upsert (not the full record) so it can
  // never revert a status the worker has already reported through the lock
  // that upsertJob/updateState now hold.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  if (child.pid != null) {
    upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "max-turns"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  // Throws (exit 1) on an invalid value.
  const maxTurns = normalizeMaxTurns(options["max-turns"]) ?? DEFAULT_REVIEW_MAX_TURNS;

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const workspaceConfig = getConfig(workspaceRoot);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const { model, warnings } = await resolveRunModel({ requested: options.model, config: workspaceConfig });
  emitWarnings(warnings);

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        focusText,
        reviewName: config.reviewName,
        warnings,
        maxTurns,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

// Find the newest finished `task` job for the current Claude session (or, if
// no session id is set, the newest finished task job overall). Stop-gate
// review runs are skipped: they are read-only reviews, not the user's rescue
// work. Shared by the `task-resume-candidate` subcommand and `task --continue`.
function resolveTaskResumeCandidate(workspaceRoot) {
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const visibleJobs = sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;

  const indexEntry = visibleJobs.find(
    (job) =>
      job.jobClass === "task" && job.origin !== STOP_GATE_ORIGIN && job.status !== "queued" && job.status !== "running"
  ) ?? null;

  if (!indexEntry) {
    return { sessionId, candidate: null };
  }

  const stored = readStoredJob(workspaceRoot, indexEntry.id);
  const candidate = {
    id: indexEntry.id,
    status: indexEntry.status,
    title: indexEntry.title ?? null,
    summary: indexEntry.summary ?? null,
    completedAt: indexEntry.completedAt ?? null,
    updatedAt: indexEntry.updatedAt ?? null,
    claudeSessionId: stored?.claudeSessionId ?? indexEntry.claudeSessionId ?? null,
    cwd: stored?.cwd ?? indexEntry.cwd ?? null,
    model: stored?.model ?? indexEntry.model ?? null,
    profile: stored?.profile ?? indexEntry.profile ?? null,
    bashAllow: stored?.bashAllow ?? indexEntry.bashAllow ?? []
  };

  return { sessionId, candidate };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "max-turns"],
    multiValueOptions: ["allow-bash"],
    booleanOptions: ["json", "continue", "background", "thinking", "wait", "read-only", "allow-paid", "fresh"],
    aliasMap: {
      m: "model"
    }
  });

  if (options["read-only"] && options["allow-bash"]) {
    throw new Error("`--read-only` cannot be combined with `--allow-bash`.");
  }

  // Throws (exit 1) on an invalid value. --continue deliberately does NOT
  // carry the previous run's maxTurns over: this run's flag or the default
  // applies.
  const maxTurns = normalizeMaxTurns(options["max-turns"]) ?? DEFAULT_TASK_MAX_TURNS;

  const explicitCwd = Boolean(options.cwd);
  const invocationCwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = getConfig(workspaceRoot);

  const continueSession = Boolean(options.continue);
  const thinking = Boolean(options.thinking);
  const allowPaid = Boolean(options["allow-paid"]);
  const readOnly = Boolean(options["read-only"]);
  const origin = process.env[JOB_ORIGIN_ENV] === STOP_GATE_ORIGIN ? STOP_GATE_ORIGIN : null;

  let prompt = readTaskPrompt(invocationCwd, options, positionals);
  let cwd = invocationCwd;
  let resumeSessionId = null;
  let carriedModel = null;
  let carriedProfile = null;

  if (continueSession) {
    const { candidate } = resolveTaskResumeCandidate(workspaceRoot);
    if (!candidate) {
      throw new Error("No resumable NanoGPT task found for this session. Run without --continue to start a new task.");
    }
    if (!candidate.claudeSessionId) {
      throw new Error(
        `Task ${candidate.id} has no NanoGPT session to resume (it may have failed before one was created). Run without --continue to start a new task.`
      );
    }
    resumeSessionId = candidate.claudeSessionId;
    if (!explicitCwd && candidate.cwd) {
      cwd = candidate.cwd;
    }
    carriedModel = candidate.model ?? null;
    carriedProfile = candidate.profile ?? null;
    if (!prompt) {
      prompt = "Continue from where you left off.";
    }
  }

  if (!prompt) {
    throw new Error("Provide a prompt, piped stdin, or use --continue.");
  }

  const profile = readOnly ? "read" : continueSession && carriedProfile ? carriedProfile : "write";
  const bashAllow = normalizeBashAllow([
    ...DEFAULT_BASH_ALLOW,
    ...(config.bashAllow ?? []),
    ...(options["allow-bash"] ?? [])
  ]);

  const requestedModel = options.model ? String(options.model).trim() : carriedModel;
  const { model, warnings } = await resolveRunModel({ requested: requestedModel, config, thinking, allowPaid });
  emitWarnings(warnings);

  const taskMetadata = buildTaskRunMetadata({ prompt, continueSession });

  if (options.background) {
    ensureClaudeAvailable(cwd);
    const job = buildTaskJob(workspaceRoot, taskMetadata, profile === "write", origin);
    const request = buildTaskRequest({ cwd, model, prompt, profile, bashAllow, resumeSessionId, jobId: job.id, warnings, maxTurns });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, profile === "write", origin);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        profile,
        bashAllow,
        resumeSessionId,
        jobId: job.id,
        warnings,
        maxTurns,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  // Persist the Claude session id into the stored job as soon as the stream
  // reports it, so a job that is cancelled or dies before claude prints its
  // result can still be resumed with `task --continue` once it has stopped
  // (running jobs are never resume candidates). The API key is never on this
  // path: it is resolved inside executeClaudeRun and not part of the stored
  // request.
  const onSession = (claudeSessionId) => {
    writeJobFile(workspaceRoot, storedJob.id, {
      ...readStoredJob(workspaceRoot, storedJob.id),
      claudeSessionId
    });
    upsertJob(workspaceRoot, { id: storedJob.id, claudeSessionId, phase: "running" });
  };

  let phaseRunningSeen = false;
  const onProgress = (text) => {
    if (!phaseRunningSeen && isToolUseProgressLine(text)) {
      phaseRunningSeen = true;
      upsertJob(workspaceRoot, { id: storedJob.id, phase: "running" });
    }
    progress(text);
  };

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        streaming: true,
        onProgress,
        onSession
      }),
    { logFile }
  );
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const { sessionId, candidate } = resolveTaskResumeCandidate(workspaceRoot);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
