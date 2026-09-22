#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
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
  DEFAULT_BASH_ALLOW,
  getClaudeAvailability,
  isToolUseProgressLine,
  KEY_SETUP_COMMAND,
  normalizeBashAllow,
  parseClaudeJsonOutput,
  parseStreamEvent,
  parseClaudeVersion,
  PROMPT_ARGV_LIMIT,
  requireApiKey,
  resolveApiKey,
  resolveBaseUrl,
  resolveMaxInlineChars,
  runClaude,
  summarizeClaudeResult
} from "./lib/runtime.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
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
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskRun
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

// Model resolution seam. This step ignores `thinking`/`allowPaid`; step 5
// replaces the body with a catalog-backed lookup (lib/models.mjs) but keeps
// this same async signature so callers do not need to change.
const DEFAULT_MODEL = "z-ai/glm-5.2";

async function resolveRunModel({ requested, config, thinking, allowPaid } = {}) {
  void thinking;
  void allowPaid;
  const trimmedRequested = requested ? String(requested).trim() : "";
  if (trimmedRequested) {
    return trimmedRequested;
  }
  const configModel = config?.model ? String(config.model).trim() : "";
  if (configModel) {
    return configModel;
  }
  return DEFAULT_MODEL;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/nano-companion.mjs setup [--json]",
      "  node scripts/nano-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>]",
      "  node scripts/nano-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]",
      "  node scripts/nano-companion.mjs task [--background] [--continue] [--model <model>] [--thinking] [--read-only] [--allow-bash <prefix>] [--allow-paid] [prompt]",
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

async function buildSetupReport(cwd, actionsTaken = []) {
  const claudeAvailability = getClaudeAvailability(cwd);
  const version = claudeAvailability.available ? parseClaudeVersion(claudeAvailability.detail) : null;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const reviewGateEnabled = Boolean(config.stopReviewGate);
  const apiKey = resolveApiKey();

  const nextSteps = [];
  if (!claudeAvailability.available) {
    nextSteps.push("Install Claude Code (https://claude.com/claude-code), then rerun `/nano:setup`.");
  }
  if (!apiKey.key) {
    nextSteps.push(KEY_SETUP_COMMAND);
  }
  if (claudeAvailability.available && apiKey.key && !reviewGateEnabled) {
    nextSteps.push("Optional: run `/nano:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: claudeAvailability.available && Boolean(apiKey.key),
    claude: {
      available: claudeAvailability.available,
      detail: claudeAvailability.detail,
      version
    },
    apiKey: {
      present: Boolean(apiKey.key),
      source: apiKey.source
    },
    reviewGateEnabled,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// ---------------------------------------------------------------------------
// shared executor: spawn `claude -p` against NanoGPT and collect the result
// ---------------------------------------------------------------------------

/**
 * request = { cwd, prompt, model, profile ("read"|"write"|profile object),
 *   bashAllow, resumeSessionId, streaming, onProgress, onSession }
 *
 * The API key is resolved fresh here (never taken from `request`), so a
 * queued background job's stored request never contains it. Returns
 * `{ exitStatus, summary (null if no JSON), permissions, model, stderr,
 * stdout }`. `exitStatus` is 0 only if the process exited 0 AND the stdout
 * parsed as JSON AND `summary.isError` is false.
 *
 * With `streaming` the run uses `--output-format stream-json --verbose` and
 * each stdout line is fed to parseStreamEvent: progress strings are passed to
 * `onProgress` (so they land in the job log) and the first session id seen is
 * passed to `onSession`. The final summary still comes from the last
 * `type: "result"` line via parseClaudeJsonOutput.
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
  onSession = null
}) {
  const permissions = typeof profile === "object" && profile !== null ? profile : buildPermissionProfile(profile, { bashAllow });

  const { key: apiKey } = requireApiKey();
  const env = buildChildEnv({ apiKey, model, baseUrl: resolveBaseUrl() });
  const promptViaStdin = prompt.length > PROMPT_ARGV_LIMIT;
  const args = buildClaudeArgs({
    prompt,
    model,
    profile: permissions,
    resumeSessionId,
    outputFormat: streaming ? "stream-json" : "json",
    promptViaStdin
  });

  if (typeof onProgress === "function") {
    onProgress(`Running NanoGPT (${model}, profile=${permissions.name})...`);
  }

  let sessionIdSeen = false;
  const onStdoutLine = streaming
    ? (line) => {
        const event = parseStreamEvent(line, { cwd });
        if (!event) {
          return;
        }
        if (event.sessionId && !sessionIdSeen) {
          sessionIdSeen = true;
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

  const result = await runClaude({
    cwd,
    args,
    env,
    input: promptViaStdin ? prompt : null,
    onStdoutLine
  });

  const parsed = parseClaudeJsonOutput(result.stdout);
  const summary = parsed ? summarizeClaudeResult(parsed) : null;
  const exitStatus = result.status === 0 && summary && summary.isError === false ? 0 : (result.status || 1);

  appendRunLog(
    buildRunLogEntry({
      model,
      cwd,
      allowedTools: permissions.allowedTools,
      task: prompt,
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
    permissions,
    model,
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
    onProgress: request.onProgress
  });

  const rendered = renderReviewResult({
    reviewLabel: reviewName,
    targetLabel: context.target.label,
    summary: run.summary,
    model: run.model,
    stdout: run.stdout,
    stderr: run.stderr
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
    stderr: run.stderr
  };

  return {
    exitStatus: run.exitStatus,
    payload,
    rendered,
    summary: run.summary
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

  const run = await executeClaudeRun({
    cwd: request.cwd,
    prompt,
    model: request.model,
    profile: request.profile,
    bashAllow: request.bashAllow,
    resumeSessionId: request.resumeSessionId ?? null,
    streaming: request.streaming ?? false,
    onProgress: request.onProgress,
    onSession: request.onSession
  });

  const { rendered, footer } = renderTaskRun({
    summary: run.summary,
    model: run.model,
    jobId: request.jobId ?? null,
    maxChars: resolveMaxInlineChars(),
    stdout: run.stdout,
    stderr: run.stderr
  });

  const payload = {
    status: run.exitStatus,
    isError: run.summary ? run.summary.isError : true,
    rawOutput: run.summary ? run.summary.text : "",
    claudeSessionId: run.summary?.sessionId ?? null,
    model: run.model,
    profile: run.permissions.name,
    bashAllow: run.permissions.bashAllow,
    usage: run.summary?.usage ?? {},
    permissionDenials: run.summary?.permissionDenials ?? [],
    numTurns: run.summary?.numTurns ?? null,
    durationMs: run.summary?.durationMs ?? null,
    stderr: run.stderr,
    footer
  };

  const summary = run.summary
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
      claudeSessionId: payload.claudeSessionId,
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

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, prompt, profile, bashAllow, resumeSessionId, jobId }) {
  return {
    cwd,
    model,
    prompt,
    profile,
    bashAllow,
    resumeSessionId,
    jobId
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

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

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
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

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

  const model = await resolveRunModel({ requested: options.model, config: workspaceConfig });

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
// no session id is set, the newest finished task job overall). Shared by the
// `task-resume-candidate` subcommand and `task --continue`.
function resolveTaskResumeCandidate(workspaceRoot) {
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const visibleJobs = sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;

  const indexEntry = visibleJobs.find(
    (job) => job.jobClass === "task" && job.status !== "queued" && job.status !== "running"
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
    valueOptions: ["model", "cwd"],
    multiValueOptions: ["allow-bash"],
    booleanOptions: ["json", "continue", "background", "thinking", "wait", "read-only", "allow-paid", "fresh"],
    aliasMap: {
      m: "model"
    }
  });

  if (options["read-only"] && options["allow-bash"]) {
    throw new Error("`--read-only` cannot be combined with `--allow-bash`.");
  }

  const explicitCwd = Boolean(options.cwd);
  const invocationCwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = getConfig(workspaceRoot);

  const continueSession = Boolean(options.continue);
  const thinking = Boolean(options.thinking);
  const allowPaid = Boolean(options["allow-paid"]);
  const readOnly = Boolean(options["read-only"]);

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
  const model = await resolveRunModel({ requested: requestedModel, config, thinking, allowPaid });

  const taskMetadata = buildTaskRunMetadata({ prompt, continueSession });

  if (options.background) {
    ensureClaudeAvailable(cwd);
    const job = buildTaskJob(workspaceRoot, taskMetadata, profile === "write");
    const request = buildTaskRequest({ cwd, model, prompt, profile, bashAllow, resumeSessionId, jobId: job.id });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, profile === "write");
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
  // reports it, so `task --continue` works for a still-running (or cancelled)
  // job, not just a finished one. The API key is never on this path: it is
  // resolved inside executeClaudeRun and not part of the stored request.
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
