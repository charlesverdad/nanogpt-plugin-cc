import test from "node:test";
import assert from "node:assert/strict";

import {
  pingNanoGpt,
  fetchSubscriptionUsage,
  formatTokenCount,
  describeSubscription
} from "../plugins/nano/scripts/lib/account.mjs";

const BASE_URL = "https://nano-gpt.com/api";
const API_KEY = "SECRET-KEY-123";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function nonJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("not json");
    },
    text: async () => body
  };
}

function messagePayload(overrides = {}) {
  return {
    type: "message",
    model: "z-ai/glm-5.2",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "OK." }],
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 3,
      cost: 0.000007,
      cost_usd: 0.000007
    },
    ...overrides
  };
}

function usagePayload(overrides = {}) {
  return {
    active: true,
    provider: "stripe",
    providerStatus: "active",
    stripeSubscriptionId: "sub_abc123",
    allowOverage: false,
    limits: { weeklyInputTokens: 60000000, dailyInputTokens: null, dailyImages: 100 },
    period: { currentPeriodEnd: "2026-10-22T06:28:41.000Z" },
    weeklyInputTokens: {
      used: 2217148,
      remaining: 57782852,
      percentUsed: 0.0369,
      resetAt: 1790553600000
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// pingNanoGpt
// ---------------------------------------------------------------------------

test("pingNanoGpt: sends POST to {baseUrl}/v1/messages with the required headers and body", async () => {
  const capture = {};
  const fetchImpl = async (url, options) => {
    capture.url = url;
    capture.options = options;
    return jsonResponse(messagePayload());
  };
  await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, model: "z-ai/glm-5.2", fetchImpl });
  assert.equal(capture.url, `${BASE_URL}/v1/messages`);
  assert.equal(capture.options.method, "POST");
  assert.equal(capture.options.headers["x-api-key"], API_KEY);
  assert.equal(capture.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(capture.options.headers["content-type"], "application/json");
  const body = JSON.parse(capture.options.body);
  assert.equal(body.model, "z-ai/glm-5.2");
  assert.equal(body.max_tokens, 16);
  assert.deepEqual(body.messages, [{ role: "user", content: "Reply with OK." }]);
});

test("pingNanoGpt: ok result carries trimmed text and numeric cost", async () => {
  const fetchImpl = async () =>
    jsonResponse(messagePayload({ content: [{ type: "text", text: "  OK.  " }] }));
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.model, "z-ai/glm-5.2");
  assert.equal(res.text, "OK.");
  assert.equal(res.cost, 0.000007);
  assert.equal(typeof res.usage, "object");
  assert.match(res.detail, /HTTP 200, replied "OK."/);
});

test("pingNanoGpt: concatenates multiple text blocks and trims to 200 chars", async () => {
  const long = "A".repeat(150);
  const long2 = "B".repeat(150);
  const fetchImpl = async () =>
    jsonResponse(
      messagePayload({ content: [{ type: "text", text: long }, { type: "text", text: long2 }] })
    );
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.text.length, 200);
  assert.equal(res.text, (long + long2).slice(0, 200));
});

test("pingNanoGpt: cost is null when usage.cost is not a number", async () => {
  const fetchImpl = async () =>
    jsonResponse(messagePayload({ usage: { input_tokens: 7, output_tokens: 3 } }));
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.cost, null);
});

test("pingNanoGpt: non-2xx -> ok false with status in detail", async () => {
  const fetchImpl = async () => nonJsonResponse(401, `{"error":"unauthorized for ${API_KEY}"}`);
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.text, null);
  assert.equal(res.cost, null);
  assert.match(res.detail, /HTTP 401/);
  assert.equal(res.detail.includes(API_KEY), false, "api key leaked into detail");
});

test("pingNanoGpt: JSON body without type=message -> ok false", async () => {
  const fetchImpl = async () => jsonResponse({ type: "error", error: "nope" });
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 200);
  assert.match(res.detail, /HTTP 200/);
});

test("pingNanoGpt: fetch rejection -> ok false, detail prefixed with 'request failed:'", async () => {
  const fetchImpl = async () => {
    throw new Error(`boom ${API_KEY}`);
  };
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
  assert.match(res.detail, /request failed: boom/);
  assert.equal(res.detail.includes(API_KEY), false, "api key leaked into detail");
});

test("pingNanoGpt: missing apiKey -> no fetch, detail 'no API key'", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(messagePayload());
  };
  const res = await pingNanoGpt({ baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.detail, "no API key");
  assert.equal(called, false, "fetch was called despite missing apiKey");
});

test("pingNanoGpt: never returns the api key in any field even when body echoes it", async () => {
  const echo = `error: invalid key ${API_KEY} rejected`;
  const fetchImpl = async () => nonJsonResponse(403, echo);
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  for (const val of Object.values(res)) {
    if (typeof val === "string") {
      assert.equal(val.includes(API_KEY), false, `api key leaked in field: ${val}`);
    }
  }
});

test("pingNanoGpt: respects custom model in returned model and request body", async () => {
  const capture = {};
  const fetchImpl = async (url, options) => {
    capture.options = options;
    return jsonResponse(messagePayload({ model: "z-ai/glm-5.3" }));
  };
  const res = await pingNanoGpt({ apiKey: API_KEY, baseUrl: BASE_URL, model: "z-ai/glm-5.3", fetchImpl });
  assert.equal(JSON.parse(capture.options.body).model, "z-ai/glm-5.3");
  assert.equal(res.model, "z-ai/glm-5.3");
});

// ---------------------------------------------------------------------------
// fetchSubscriptionUsage
// ---------------------------------------------------------------------------

test("fetchSubscriptionUsage: parses active subscription with weekly tokens and ISO resetAt", async () => {
  const fetchImpl = async () => jsonResponse(usagePayload());
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.active, true);
  assert.equal(res.allowOverage, false);
  assert.equal(res.weeklyLimit, 60000000);
  assert.equal(res.weeklyUsed, 2217148);
  assert.equal(res.weeklyRemaining, 57782852);
  assert.equal(res.resetAt, new Date(1790553600000).toISOString());
  assert.equal(res.periodEnd, "2026-10-22T06:28:41.000Z");
});

test("fetchSubscriptionUsage: does not expose provider or stripeSubscriptionId", async () => {
  const fetchImpl = async () => jsonResponse(usagePayload());
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal("provider" in res, false);
  assert.equal("stripeSubscriptionId" in res, false);
  assert.equal("providerStatus" in res, false);
});

test("fetchSubscriptionUsage: sends x-api-key header to {baseUrl}/subscription/v1/usage", async () => {
  const capture = {};
  const fetchImpl = async (url, options) => {
    capture.url = url;
    capture.options = options;
    return jsonResponse(usagePayload());
  };
  await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(capture.url, `${BASE_URL}/subscription/v1/usage`);
  assert.equal(capture.options.headers["x-api-key"], API_KEY);
});

test("fetchSubscriptionUsage: response without weeklyInputTokens -> nulls", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      active: true,
      allowOverage: true,
      limits: { weeklyInputTokens: null },
      period: { currentPeriodEnd: "2026-10-22T06:28:41.000Z" }
    });
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.active, true);
  assert.equal(res.allowOverage, true);
  assert.equal(res.weeklyLimit, null);
  assert.equal(res.weeklyUsed, null);
  assert.equal(res.weeklyRemaining, null);
  assert.equal(res.resetAt, null);
  assert.equal(res.periodEnd, "2026-10-22T06:28:41.000Z");
});

test("fetchSubscriptionUsage: non-2xx -> ok false with status in detail and null fields", async () => {
  const fetchImpl = async () => nonJsonResponse(401, `unauthorized key=${API_KEY}`);
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.active, null);
  assert.equal(res.weeklyUsed, null);
  assert.equal(res.resetAt, null);
  assert.match(res.detail, /HTTP 401/);
  assert.equal(res.detail.includes(API_KEY), false, "api key leaked into detail");
});

test("fetchSubscriptionUsage: fetch rejection -> ok false, no key leak", async () => {
  const fetchImpl = async () => {
    throw new Error(`network ${API_KEY} down`);
  };
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.detail, /request failed/);
  assert.equal(res.detail.includes(API_KEY), false, "api key leaked into detail");
});

test("fetchSubscriptionUsage: missing apiKey -> no fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(usagePayload());
  };
  const res = await fetchSubscriptionUsage({ baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.detail, "no API key");
  assert.equal(called, false);
});

test("fetchSubscriptionUsage: JSON array body -> ok false", async () => {
  const fetchImpl = async () => jsonResponse([1, 2, 3]);
  const res = await fetchSubscriptionUsage({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.detail, /HTTP 200/);
});

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

test("formatTokenCount: M with one decimal", () => {
  assert.equal(formatTokenCount(57_782_852), "57.8M");
  assert.equal(formatTokenCount(2_217_148), "2.2M");
  assert.equal(formatTokenCount(60_000_000), "60.0M");
});

test("formatTokenCount: k rounded to integer", () => {
  assert.equal(formatTokenCount(950_000), "950k");
  assert.equal(formatTokenCount(2217), "2k");
  assert.equal(formatTokenCount(1000), "1k");
});

test("formatTokenCount: small numbers as rounded integer", () => {
  assert.equal(formatTokenCount(12), "12");
  assert.equal(formatTokenCount(12.6), "13");
});

test("formatTokenCount: non-numbers -> '?'", () => {
  assert.equal(formatTokenCount(null), "?");
  assert.equal(formatTokenCount(undefined), "?");
  assert.equal(formatTokenCount("12"), "?");
  assert.equal(formatTokenCount(NaN), "?");
  assert.equal(formatTokenCount(Infinity), "?");
});

// ---------------------------------------------------------------------------
// describeSubscription
// ---------------------------------------------------------------------------

test("describeSubscription: active summary line", () => {
  const usage = {
    ok: true,
    active: true,
    allowOverage: false,
    weeklyLimit: 60000000,
    weeklyUsed: 2217148,
    weeklyRemaining: 57782852,
    resetAt: "2026-09-29T00:00:00.000Z",
    periodEnd: "2026-10-22T06:28:41.000Z",
    detail: "HTTP 200"
  };
  assert.equal(
    describeSubscription(usage),
    "active, 2.2M of 60.0M weekly input tokens used (57.8M left, resets 2026-09-29T00:00:00.000Z)"
  );
});

test("describeSubscription: not ok -> unavailable (<detail>)", () => {
  assert.equal(
    describeSubscription({ ok: false, detail: "HTTP 401: nope" }),
    "unavailable (HTTP 401: nope)"
  );
  assert.equal(describeSubscription(null), "unavailable (unknown)");
  assert.equal(describeSubscription(undefined), "unavailable (unknown)");
});

test("describeSubscription: ok but inactive -> 'inactive'", () => {
  const usage = {
    ok: true,
    active: false,
    allowOverage: null,
    weeklyLimit: null,
    weeklyUsed: null,
    weeklyRemaining: null,
    resetAt: null,
    periodEnd: null,
    detail: "HTTP 200"
  };
  assert.equal(describeSubscription(usage), "inactive");
});
