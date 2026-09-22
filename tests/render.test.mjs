import test from "node:test";
import assert from "node:assert/strict";

import { renderNoResultBody, renderReviewResult, renderStoredJobResult, renderTaskRun } from "../plugins/nano/scripts/lib/render.mjs";

test("renderReviewResult renders the result text under a NanoGPT review header, with a footer", () => {
  const output = renderReviewResult({
    reviewLabel: "Adversarial Review",
    targetLabel: "working tree diff",
    summary: {
      text: "Verdict: approve\nLooks fine.",
      isError: false,
      numTurns: 2,
      durationMs: 1000,
      sessionId: "sid",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      permissionDenials: []
    },
    model: "z-ai/glm-5.2"
  });

  assert.match(output, /^# NanoGPT Adversarial Review/);
  assert.match(output, /Target: working tree diff/);
  assert.match(output, /Verdict: approve/);
  assert.match(output, /Looks fine\./);
  assert.match(output, /\[nano\] model=z-ai\/glm-5\.2/);
});

test("renderReviewResult prefixes a failure notice when the summary is an error", () => {
  const output = renderReviewResult({
    reviewLabel: "Review",
    targetLabel: "working tree diff",
    summary: {
      text: "API Error: boom",
      isError: true,
      numTurns: 1,
      durationMs: 100,
      sessionId: "sid",
      usage: {},
      permissionDenials: []
    },
    model: "m"
  });

  assert.match(output, /NanoGPT review failed:\n\nAPI Error: boom/);
});

test("renderReviewResult reports empty output when the summary text is blank", () => {
  const output = renderReviewResult({
    reviewLabel: "Review",
    targetLabel: "working tree diff",
    summary: { text: "", isError: false, numTurns: 1, durationMs: 0, sessionId: null, usage: {}, permissionDenials: [] },
    model: "m"
  });

  assert.match(output, /NanoGPT review completed without any output\./);
});

test("renderReviewResult falls back to renderNoResultBody (no footer) when there is no summary", () => {
  const output = renderReviewResult({
    reviewLabel: "Review",
    targetLabel: "working tree diff",
    summary: null,
    model: "m",
    stderr: "boom"
  });

  assert.match(output, /NanoGPT did not return a result\./);
  assert.match(output, /```text\nboom\n```/);
  assert.doesNotMatch(output, /\[nano\]/);
});

test("renderNoResultBody prefers stderr over stdout and omits the code block when both are empty", () => {
  assert.match(renderNoResultBody({ stderr: "err text", stdout: "out text" }), /```text\nerr text\n```/);
  assert.match(renderNoResultBody({ stdout: "out text" }), /```text\nout text\n```/);
  assert.equal(renderNoResultBody({}), "NanoGPT did not return a result.\n");
});

test("renderTaskRun truncates for inline display and returns the footer separately", () => {
  const summary = {
    text: "x".repeat(9000),
    isError: false,
    numTurns: 4,
    durationMs: 2000,
    sessionId: "sid-1",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    permissionDenials: []
  };
  const { rendered, footer } = renderTaskRun({ summary, model: "m", jobId: "job-1" });

  assert.match(rendered, /truncated, full output: \/nano:result job-1/);
  assert.match(footer, /^\[nano\] model=m turns=4/);
  assert.ok(rendered.endsWith(`${footer}\n`));
});

test("renderTaskRun prefixes a failure notice when the summary is an error", () => {
  const summary = {
    text: "API Error: boom",
    isError: true,
    numTurns: 1,
    durationMs: 10,
    sessionId: "sid",
    usage: {},
    permissionDenials: []
  };
  const { rendered } = renderTaskRun({ summary, model: "m" });
  assert.match(rendered, /^NanoGPT run failed:\n\nAPI Error: boom/);
});

test("renderTaskRun falls back to renderNoResultBody (no footer) when there is no summary", () => {
  const { rendered, footer } = renderTaskRun({ summary: null, model: "m", stdout: "raw stdout tail" });
  assert.match(rendered, /NanoGPT did not return a result\./);
  assert.match(rendered, /raw stdout tail/);
  assert.equal(footer, null);
});

test("renderStoredJobResult prefers the full untruncated rawOutput plus stored footer for task jobs", () => {
  const output = renderStoredJobResult(
    { id: "task-123", status: "completed", title: "NanoGPT Task" },
    {
      result: {
        rawOutput: "Full untruncated body.",
        isError: false,
        footer: "[nano] model=m turns=1 tokens=0in/0out secs=0 session=sid"
      }
    }
  );

  assert.match(output, /^Full untruncated body\./);
  assert.match(output, /\[nano\] model=m/);
});

test("renderStoredJobResult prefixes a failure notice for a failed task job", () => {
  const output = renderStoredJobResult(
    { id: "task-124", status: "failed", title: "NanoGPT Task" },
    { result: { rawOutput: "API Error: boom", isError: true, footer: "[nano] model=m turns=1 tokens=0in/0out secs=0 session=sid" } }
  );

  assert.match(output, /^NanoGPT run failed:\n\nAPI Error: boom/);
});

test("renderStoredJobResult falls back to rendered output for review/setup jobs", () => {
  const output = renderStoredJobResult(
    { id: "review-123", status: "completed", title: "NanoGPT Adversarial Review", jobClass: "review" },
    {
      rendered: "# NanoGPT Adversarial Review\n\nTarget: working tree diff\n\nVerdict: needs-attention\nOne issue.\n"
    }
  );

  assert.match(output, /^# NanoGPT Adversarial Review/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /\n$/);
});

test("renderStoredJobResult falls back to rendered output, then to a summary", () => {
  const renderedFallback = renderStoredJobResult(
    { id: "job-1", status: "completed", title: "NanoGPT Result" },
    { rendered: "# NanoGPT Result\n\nRendered body" }
  );
  assert.match(renderedFallback, /^# NanoGPT Result/);
  assert.match(renderedFallback, /Rendered body/);

  const summaryFallback = renderStoredJobResult(
    { id: "job-2", status: "failed", title: "NanoGPT Result", summary: "did not finish" },
    { errorMessage: "claude exited with code 1" }
  );
  assert.match(summaryFallback, /^# NanoGPT Result/);
  assert.match(summaryFallback, /Job: job-2/);
  assert.match(summaryFallback, /Status: failed/);
  assert.match(summaryFallback, /Summary: did not finish/);
  assert.match(summaryFallback, /claude exited with code 1/);
});
