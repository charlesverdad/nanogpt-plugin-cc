// Aggregation and rendering for `nano-companion usage`: reads the run log
// (runs.jsonl) and the optional MCP proxy call log (mcp-calls.jsonl) and
// summarizes tokens, failures, latency and slow runs. Everything here is pure;
// the companion does the file reading. Log lines written by older versions
// lack the newer fields, so every field is treated as possibly missing.

import path from "node:path";

import { percentile } from "./runtime.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Older log lines have no `maxTurns`/`subtype`: a run that errored with
// num_turns one past the default review (15) or task (25) cap is, in practice,
// a turn-limit stop (claude reports cap + 1).
const LEGACY_CAP_TURNS = new Set([16, 26]);

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (num(value) ?? 0), 0);
}

function average(values) {
  const nums = values.map(num).filter((value) => value !== null);
  return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

/** Parse JSONL text; blank and unparseable lines are skipped. */
export function parseJsonl(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object" && !Array.isArray(row)) {
        rows.push(row);
      }
    } catch {
      // ignore a corrupt line
    }
  }
  return rows;
}

/** Input tokens of a run: fresh + cache reads + cache creation. */
export function runInputTokens(run) {
  return (num(run.in) ?? 0) + (num(run.cache_read) ?? 0) + (num(run.cache_creation) ?? 0);
}

function runWallMs(run) {
  return num(run.wallMs) ?? num(run.ms);
}

function inWindow(row, cutoff, nowMs) {
  const time = Date.parse(row?.ts);
  return Number.isFinite(time) && time >= cutoff && time <= nowMs + DAY_MS;
}

function isMaxTurnsRun(run) {
  if (run.stopReason === "max_turns" || run.subtype === "error_max_turns" || run.terminalReason === "max_turns") {
    return true;
  }
  const turns = num(run.turns);
  const cap = num(run.maxTurns);
  if (turns !== null && cap !== null) {
    return run.is_error === true && turns > cap;
  }
  return run.is_error === true && run.subtype == null && cap === null && turns !== null && LEGACY_CAP_TURNS.has(turns);
}

/** Failure cause of a run: "max_turns", "prompt_too_long", "no_result" or "other". */
export function classifyFailure(run) {
  if (isMaxTurnsRun(run)) {
    return "max_turns";
  }
  if (/Prompt is too long/i.test(String(run.error ?? ""))) {
    return "prompt_too_long";
  }
  if (num(run.turns) === null) {
    return "no_result";
  }
  return "other";
}

function groupBy(runs, keyOf) {
  const groups = new Map();
  for (const run of runs) {
    const key = keyOf(run) ?? "unknown";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(run);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      runs: items.length,
      errors: items.filter((run) => run.is_error === true).length,
      input: sum(items.map(runInputTokens)),
      output: sum(items.map((run) => run.out)),
      avgWallMs: average(items.map(runWallMs))
    }))
    .sort((a, b) => b.runs - a.runs || String(a.key).localeCompare(String(b.key)));
}

function mcpTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const total = num(usage.total_tokens);
  if (total !== null) {
    return total;
  }
  return (
    (num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0) +
    (num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0)
  );
}

/**
 * Aggregate run-log rows (`runs`) and MCP call rows (`mcp`) over the last
 * `days` days. Rows outside the window or without a parseable `ts` are dropped.
 */
export function buildUsageReport({ runs = [], mcp = [], days = 7, now = new Date() } = {}) {
  const nowMs = now.getTime();
  const cutoff = nowMs - days * DAY_MS;
  const windowRuns = runs.filter((run) => inWindow(run, cutoff, nowMs));
  const windowMcp = mcp.filter((call) => inWindow(call, cutoff, nowMs));

  const failed = windowRuns.filter((run) => run.is_error === true);
  const quotaValues = windowRuns.map((run) => num(run.quotaDelta)).filter((value) => value !== null);
  const totals = {
    runs: windowRuns.length,
    ok: windowRuns.length - failed.length,
    errors: failed.length,
    input: sum(windowRuns.map(runInputTokens)),
    output: sum(windowRuns.map((run) => run.out)),
    quotaDelta: quotaValues.length > 0 ? sum(quotaValues) : null
  };

  // Failures by cause. Turn-limit stops are listed even when a salvage call
  // turned them into successes (is_error false), split by salvaged or not.
  const failures = { max_turns_salvaged: 0, max_turns_not_salvaged: 0, no_result: 0, prompt_too_long: 0, other: 0 };
  for (const run of windowRuns) {
    const cause = run.is_error === true || isMaxTurnsRun(run) ? classifyFailure(run) : null;
    if (cause === "max_turns") {
      failures[run.salvaged === true ? "max_turns_salvaged" : "max_turns_not_salvaged"] += 1;
    } else if (cause) {
      failures[cause] += 1;
    }
  }

  const callMs = windowRuns.flatMap((run) => (Array.isArray(run.calls) ? run.calls.map((call) => num(call?.ms)) : [])).filter((ms) => ms !== null);
  const latency = {
    calls: callMs.length,
    p50: percentile(callMs, 50),
    p95: percentile(callMs, 95),
    max: callMs.length > 0 ? Math.max(...callMs) : null
  };

  const slowest = windowRuns
    .filter((run) => runWallMs(run) !== null)
    .sort((a, b) => runWallMs(b) - runWallMs(a))
    .slice(0, 5)
    .map((run) => ({
      ts: run.ts,
      kind: run.kind ?? "unknown",
      model: run.model ?? "unknown",
      wallSecs: Math.round(runWallMs(run) / 1000),
      turns: num(run.turns),
      input: runInputTokens(run),
      project: run.cwd ? path.basename(String(run.cwd)) : null
    }));

  const tools = new Map();
  for (const call of windowMcp) {
    const key = call.tool ?? "unknown";
    if (!tools.has(key)) {
      tools.set(key, { tool: key, calls: 0, errors: 0, tokens: 0, ms: [], media: 0 });
    }
    const entry = tools.get(key);
    entry.calls += 1;
    if (call.ok === false) {
      entry.errors += 1;
    }
    entry.tokens += mcpTokens(call.usage);
    entry.ms.push(call.ms);
    entry.media += Array.isArray(call.media) ? call.media.length : 0;
  }
  const mcpTools = [...tools.values()]
    .map(({ ms, ...rest }) => ({ ...rest, avgMs: average(ms) }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  return {
    days,
    since: new Date(cutoff).toISOString(),
    totals,
    byKind: groupBy(windowRuns, (run) => run.kind),
    byModel: groupBy(windowRuns, (run) => run.model),
    failures,
    latency,
    slowest,
    mcp: {
      calls: windowMcp.length,
      errors: windowMcp.filter((call) => call.ok === false).length,
      mediaFiles: sum(mcpTools.map((tool) => tool.media)),
      tools: mcpTools
    }
  };
}

function fmtTokens(value) {
  const n = num(value) ?? 0;
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function fmtSecs(ms) {
  return ms === null || ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact text rendering of a buildUsageReport result. */
export function renderUsageReport(report) {
  const lines = [];
  const { totals } = report;
  lines.push(`# NanoGPT usage, last ${report.days} day${report.days === 1 ? "" : "s"} (since ${report.since.slice(0, 16)}Z)`);
  if (report.logs) {
    lines.push(`Run log: ${report.logs.runs}${report.logs.runsFound ? "" : " (not found)"}`);
    lines.push(`MCP log: ${report.logs.mcp}${report.logs.mcpFound ? "" : " (not found)"}`);
  }
  lines.push("");
  lines.push(
    `Totals: ${totals.runs} runs (${totals.ok} ok, ${totals.errors} error), input ${fmtTokens(totals.input)}, output ${fmtTokens(totals.output)}` +
      (totals.quotaDelta !== null ? `, sum of quota deltas ${fmtTokens(totals.quotaDelta)} (overstated when runs overlap)` : "")
  );

  for (const [title, rows] of [
    ["By kind", report.byKind],
    ["By model", report.byModel]
  ]) {
    if (rows.length === 0) {
      continue;
    }
    lines.push("", `${title}:`);
    for (const row of rows) {
      lines.push(
        `- ${row.key}: ${row.runs} runs, ${row.errors} errors, in ${fmtTokens(row.input)}, out ${fmtTokens(row.output)}, avg ${fmtSecs(row.avgWallMs)}`
      );
    }
  }

  const f = report.failures;
  const failureRows = [
    [`max_turns (${f.max_turns_salvaged} salvaged / ${f.max_turns_not_salvaged} not)`, f.max_turns_salvaged + f.max_turns_not_salvaged],
    ["no result", f.no_result],
    ["prompt too long", f.prompt_too_long],
    ["other", f.other]
  ].filter(([, count]) => count > 0);
  lines.push("", "Failures by cause:");
  if (failureRows.length === 0) {
    lines.push("- none");
  }
  for (const [label, count] of failureRows) {
    lines.push(`- ${label}: ${count}`);
  }

  lines.push("", "API call latency:");
  if (report.latency.calls === 0) {
    lines.push("- no per-call data yet");
  } else {
    lines.push(
      `- ${report.latency.calls} calls: p50 ${fmtSecs(report.latency.p50)}, p95 ${fmtSecs(report.latency.p95)}, max ${fmtSecs(report.latency.max)}`
    );
  }

  if (report.slowest.length > 0) {
    lines.push("", "Slowest runs:");
    for (const run of report.slowest) {
      lines.push(
        `- ${run.ts} ${run.kind} ${run.model} ${run.wallSecs}s turns=${run.turns ?? "?"} in=${fmtTokens(run.input)} ${run.project ?? ""}`.trimEnd()
      );
    }
  }

  if (report.mcp.calls > 0) {
    lines.push("", `MCP tools (${report.mcp.calls} calls, ${report.mcp.errors} errors, ${report.mcp.mediaFiles} media files saved):`);
    for (const tool of report.mcp.tools) {
      lines.push(
        `- ${tool.tool}: ${tool.calls} calls, ${tool.errors} errors, ${fmtTokens(tool.tokens)} tokens, avg ${fmtSecs(tool.avgMs)}, ${tool.media} media`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
