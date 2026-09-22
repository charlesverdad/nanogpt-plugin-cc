import { formatTokenCount } from "./account.mjs";
import { isMaxTurnsStop } from "./runtime.mjs";

/**
 * Message shown when a run stopped at the --max-turns cap before finishing.
 * Tasks can resume with --continue; reviews cannot, so they get a rerun hint
 * only.
 */
export function maxTurnsStopMessage(maxTurns, { canContinue = true } = {}) {
  const cap = typeof maxTurns === "number" ? maxTurns : "?";
  const hint = canContinue
    ? "Continue where it left off with --continue, or rerun with a higher --max-turns."
    : "Rerun with a higher --max-turns.";
  return `Stopped at the turn limit (${cap} turns) before finishing. ${hint}`;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /nano:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /nano:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /nano:review --wait");
    lines.push("  Stricter review: /nano:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/nano:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/nano:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# NanoGPT Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks ?? []) {
    const mark = check.ok ? "ok" : "!!";
    lines.push(`- [${mark}] ${check.label}: ${check.detail}`);
  }

  lines.push("", `Default model: ${report.defaultModel}`, "");

  lines.push("Aliases:");
  for (const alias of report.aliases ?? []) {
    lines.push(`- ${alias}`);
  }
  lines.push("");

  lines.push("Bash allowlist:");
  for (const prefix of report.bashAllow ?? []) {
    lines.push(`- ${prefix}`);
  }
  lines.push("");

  lines.push(`Review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`);
  lines.push(`Catalog source: ${report.catalogSource ?? "unknown"}`);
  lines.push("");

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Fallback body used when a `claude` run produced no parseable JSON result
 * (a crash, a timeout, or a non-JSON stdout). There is no footer in this
 * case: without a result object there are no turns/tokens/session to report.
 */
export function renderNoResultBody({ stdout = "", stderr = "" } = {}) {
  const tail = String(stderr ?? "").trim() || String(stdout ?? "").trim();
  const lines = ["NanoGPT did not return a result."];
  if (tail) {
    lines.push("", "```text", tail, "```");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render a `review` / `adversarial-review` run: header, target, the full
 * (untruncated) result text, and the run footer. When there is no parseable
 * result, falls back to `renderNoResultBody` with no footer.
 */
export function renderReviewResult({ reviewLabel, targetLabel, summary, model, stdout = "", stderr = "", warnings = [], quota = null, maxTurns = null } = {}) {
  const lines = [`# NanoGPT ${reviewLabel}`, "", `Target: ${targetLabel}`, ""];

  if (!summary) {
    lines.push(renderNoResultBody({ stdout, stderr }).trimEnd());
    const trimmed = lines.join("\n").trimEnd();
    return `${trimmed}\n`;
  }

  if (isMaxTurnsStop(summary)) {
    lines.push(maxTurnsStopMessage(maxTurns, { canContinue: false }));
  } else {
    const text = String(summary.text ?? "").trim() || "NanoGPT review completed without any output.";
    lines.push(summary.isError ? `NanoGPT review failed:\n\n${text}` : text);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("", renderRunFooter({ model, summary, quota }));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a foreground/job body for a `task` run: the (possibly truncated,
 * for inline display) result text plus the run footer. Returns both the
 * rendered string and the footer alone, so the caller can store the footer
 * separately for a later untruncated re-render (see `renderStoredJobResult`).
 * Falls back to `renderNoResultBody` (no footer) when there is no parseable
 * result at all.
 */
export function renderTaskRun({ summary, model, jobId = null, maxChars, stdout = "", stderr = "", warnings = [], quota = null, maxTurns = null } = {}) {
  if (!summary) {
    return { rendered: renderNoResultBody({ stdout, stderr }), footer: null };
  }

  const footer = renderRunFooter({ model, summary, quota });
  let body;
  if (isMaxTurnsStop(summary)) {
    body = maxTurnsStopMessage(maxTurns, { canContinue: true });
  } else {
    const { text } = truncateInline(summary.text, { maxChars, jobId });
    body = summary.isError ? `NanoGPT run failed:\n\n${text}` : text;
  }
  const lines = [body];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("", footer);
  return { rendered: `${lines.join("\n")}\n`, footer };
}

export function renderStatusReport(report) {
  const lines = [
    "# NanoGPT Status",
    "",
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# NanoGPT Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) || "";
  if (rawOutput) {
    const isError = Boolean(storedJob?.result?.isError);
    const footer = typeof storedJob?.result?.footer === "string" ? storedJob.result.footer : "";
    const body = isError ? `NanoGPT run failed:\n\n${rawOutput}` : rawOutput;
    const withFooter = footer ? `${body}\n\n${footer}` : body;
    return withFooter.endsWith("\n") ? withFooter : `${withFooter}\n`;
  }

  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }

  const lines = [
    `# ${job.title ?? "NanoGPT Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# NanoGPT Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/nano:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// claude output rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render permission denials as `Tool(detail)` entries, deduplicated and joined
 * by ", ". Detail is the command/file_path/pattern; entries longer than 60
 * chars become "…" + the last 59 chars (mirrors bin/nano-agent's footer).
 */
export function formatDenials(denials = []) {
  if (!Array.isArray(denials)) {
    return "";
  }
  const rendered = new Set();
  for (const denial of denials) {
    if (!denial) {
      continue;
    }
    const toolName = denial.tool_name ?? "";
    let detail = String(denial.tool_input?.command ?? denial.tool_input?.file_path ?? denial.tool_input?.pattern ?? "");
    if (detail.length > 60) {
      detail = `…${detail.slice(-59)}`;
    }
    rendered.add(`${toolName}(${detail})`);
  }
  return [...rendered].join(", ");
}

/**
 * One-line run footer mirroring bin/nano-agent's `[nano-agent] ...` footer.
 * With a `quota` object (buildRunQuota), appends `quota=+<delta>` (omitted when
 * the delta is unknown or negative — a negative delta means the weekly window
 * reset mid-run) and `week=<percent>%` (omitted when not computable).
 */
export function renderRunFooter({ model, summary, quota = null }) {
  const usage = summary.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const numTurns = summary.numTurns ?? "?";
  const secs = Math.floor((summary.durationMs ?? 0) / 1000);
  const session = summary.sessionId ?? "none";
  let footer = `[nano] model=${model} turns=${numTurns} tokens=${inputTokens + cacheRead}in/${outputTokens}out secs=${secs} session=${session}`;
  if (quota && typeof quota.delta === "number" && quota.delta >= 0) {
    footer += ` quota=+${formatTokenCount(quota.delta)}`;
  }
  if (quota && typeof quota.weekPercent === "number") {
    footer += ` week=${quota.weekPercent}%`;
  }
  if (Array.isArray(summary.permissionDenials) && summary.permissionDenials.length > 0) {
    footer += ` denied=${formatDenials(summary.permissionDenials)}`;
  }
  return footer;
}

/**
 * Truncate inline result text to `maxChars`, noting where the full output
 * lives when a `jobId` is supplied.
 */
export function truncateInline(text, { maxChars = 8000, jobId = null } = {}) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const head = value.slice(0, maxChars).trimEnd();
  const suffix = jobId ? `\n\n… truncated, full output: /nano:result ${jobId}` : `\n\n… truncated (${value.length} chars total)`;
  return { text: head + suffix, truncated: true };
}
