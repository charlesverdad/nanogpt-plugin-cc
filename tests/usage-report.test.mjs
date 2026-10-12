import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUsageReport,
  classifyFailure,
  parseJsonl,
  renderUsageReport
} from "../plugins/nano/scripts/lib/usage-report.mjs";

const NOW = new Date("2026-03-10T12:00:00.000Z");

const RUN_LINES = [
  // new-format successful review
  { ts: "2026-03-09T10:00:00.000Z", model: "z-ai/glm-5.2", cwd: "/work/app", kind: "review", is_error: false, turns: 5, in: 100, cache_read: 900, cache_creation: 50, out: 70, ms: 5000, wallMs: 8000, quotaDelta: 1000, calls: [{ ms: 2000 }, { ms: 4000 }] },
  // salvaged max-turns task
  { ts: "2026-03-09T11:00:00.000Z", model: "z-ai/glm-5.2", cwd: "/work/app", kind: "task", is_error: false, turns: 26, in: 200, cache_read: 800, out: 90, stopReason: "max_turns", salvaged: true, maxTurns: 25, wallMs: 90000, calls: [{ ms: 30000 }, { ms: 60000, salvage: true }] },
  // unsalvaged max-turns (old line: no new fields, errored at 16 turns)
  { ts: "2026-03-08T11:00:00.000Z", model: "minimax/minimax-m3", cwd: "/work/other", is_error: true, turns: 16, in: 10, cache_read: 20, out: 1, ms: 40000 },
  // no result
  { ts: "2026-03-08T12:00:00.000Z", model: "z-ai/glm-5.2", kind: "task", is_error: true, turns: null, in: 0, cache_read: 0, out: 0, ms: null, error: "claude exited 1: boom" },
  // prompt too long
  { ts: "2026-03-08T13:00:00.000Z", model: "z-ai/glm-5.2", kind: "review", is_error: true, turns: 1, in: 0, cache_read: 0, out: 0, ms: 100, error: "Prompt is too long" },
  // other error
  { ts: "2026-03-07T13:00:00.000Z", model: "z-ai/glm-5.2", kind: "task", is_error: true, turns: 3, in: 1, cache_read: 1, out: 1, ms: 100, error: "API Error: x" },
  // ping
  { ts: "2026-03-09T09:00:00.000Z", model: "z-ai/glm-5.2", kind: "ping", is_error: false, in: 9, cache_read: 0, out: 2, ms: 700 },
  // outside the window
  { ts: "2026-01-01T00:00:00.000Z", model: "old", is_error: true, turns: 2, in: 999, out: 999, ms: 1 },
  // unusable timestamp
  { ts: "garbage", model: "bad", in: 5 }
];

const MCP_LINES = [
  { ts: "2026-03-09T10:00:00.000Z", tool: "nanogpt_image_generate", ok: true, ms: 4000, model: "m", usage: null, error: null, media: ["/a.png", "/b.png"] },
  { ts: "2026-03-09T10:05:00.000Z", tool: "nanogpt_chat", ok: true, ms: 1000, model: "m", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, error: null, media: [] },
  { ts: "2026-03-09T10:06:00.000Z", tool: "nanogpt_chat", ok: false, ms: 3000, model: "m", usage: { prompt_tokens: 4, completion_tokens: 1 }, error: "bad", media: [] },
  { ts: "2025-01-01T00:00:00.000Z", tool: "nanogpt_chat", ok: true, ms: 1, usage: null, media: [] }
];

test("parseJsonl skips blank and corrupt lines", () => {
  const rows = parseJsonl('{"a":1}\n\nnot json\n[1]\n{"b":2}\n');
  assert.deepEqual(rows, [{ a: 1 }, { b: 2 }]);
});

test("buildUsageReport aggregates totals, kinds, models and failures", () => {
  const report = buildUsageReport({ runs: RUN_LINES, mcp: MCP_LINES, days: 7, now: NOW });

  assert.equal(report.totals.runs, 7);
  assert.equal(report.totals.errors, 4);
  assert.equal(report.totals.ok, 3);
  // in + cache_read + cache_creation
  assert.equal(report.totals.input, 100 + 900 + 50 + 200 + 800 + 10 + 20 + 1 + 1 + 9);
  assert.equal(report.totals.output, 70 + 90 + 1 + 0 + 0 + 1 + 2);
  assert.equal(report.totals.quotaDelta, 1000);

  const kinds = Object.fromEntries(report.byKind.map((row) => [row.key, row]));
  assert.equal(kinds.review.runs, 2);
  assert.equal(kinds.review.errors, 1);
  assert.equal(kinds.review.avgWallMs, Math.round((8000 + 100) / 2), "wallMs, falling back to ms");
  assert.equal(kinds.unknown.runs, 1, "old lines without kind are counted as unknown");
  assert.equal(kinds.ping.runs, 1);
  assert.equal(report.byModel.find((row) => row.key === "minimax/minimax-m3").runs, 1);

  assert.deepEqual(report.failures, {
    max_turns_salvaged: 1,
    max_turns_not_salvaged: 1,
    no_result: 1,
    prompt_too_long: 1,
    other: 1
  });
});

test("buildUsageReport computes call latency and the slowest runs", () => {
  const report = buildUsageReport({ runs: RUN_LINES, days: 7, now: NOW });
  assert.deepEqual(report.latency, { calls: 4, p50: 4000, p95: 60000, max: 60000 });
  assert.equal(report.slowest.length, 5);
  assert.deepEqual(report.slowest[0], {
    ts: "2026-03-09T11:00:00.000Z",
    kind: "task",
    model: "z-ai/glm-5.2",
    wallSecs: 90,
    turns: 26,
    input: 1000,
    project: "app"
  });
  assert.equal(report.slowest[1].project, "other");
});

test("buildUsageReport summarizes MCP tools and media", () => {
  const report = buildUsageReport({ runs: [], mcp: MCP_LINES, days: 7, now: NOW });
  assert.equal(report.mcp.calls, 3);
  assert.equal(report.mcp.errors, 1);
  assert.equal(report.mcp.mediaFiles, 2);
  const chat = report.mcp.tools.find((tool) => tool.tool === "nanogpt_chat");
  assert.deepEqual(chat, { tool: "nanogpt_chat", calls: 2, errors: 1, tokens: 15 + 5, media: 0, avgMs: 2000 });
  assert.equal(report.mcp.tools[0].tool, "nanogpt_chat", "sorted by call count");
});

test("a wider window includes older rows and an empty log is fine", () => {
  assert.equal(buildUsageReport({ runs: RUN_LINES, days: 365, now: NOW }).totals.runs, 8);
  const empty = buildUsageReport({ runs: [], mcp: [], days: 7, now: NOW });
  assert.equal(empty.totals.runs, 0);
  assert.equal(empty.latency.p50, null);
  assert.equal(empty.totals.quotaDelta, null);
});

test("classifyFailure picks the right cause", () => {
  assert.equal(classifyFailure({ is_error: true, subtype: "error_max_turns", turns: 3 }), "max_turns");
  assert.equal(classifyFailure({ is_error: true, turns: 6, maxTurns: 5 }), "max_turns");
  assert.equal(classifyFailure({ is_error: true, turns: 5, maxTurns: 5, error: "Prompt is too long: 300000" }), "prompt_too_long");
  assert.equal(classifyFailure({ is_error: true, turns: null }), "no_result");
  assert.equal(classifyFailure({ is_error: true, turns: 2, error: "x" }), "other");
});

test("renderUsageReport prints each section compactly", () => {
  const report = buildUsageReport({ runs: RUN_LINES, mcp: MCP_LINES, days: 7, now: NOW });
  report.logs = { runs: "/d/runs.jsonl", mcp: "/d/mcp-calls.jsonl", runsFound: true, mcpFound: false };
  const text = renderUsageReport(report);
  assert.match(text, /last 7 days/);
  assert.match(text, /Run log: \/d\/runs\.jsonl\n/);
  assert.match(text, /MCP log: \/d\/mcp-calls\.jsonl \(not found\)/);
  assert.match(text, /Totals: 7 runs \(3 ok, 4 error\)/);
  assert.match(text, /By kind:/);
  assert.match(text, /By model:/);
  assert.match(text, /max_turns \(1 salvaged \/ 1 not\): 2/);
  assert.match(text, /prompt too long: 1/);
  assert.match(text, /4 calls: p50 4\.0s, p95 60\.0s, max 60\.0s/);
  assert.match(text, /Slowest runs:/);
  assert.match(text, /nanogpt_image_generate: 1 calls/);
  assert.match(text, /2 media files saved/);
});
