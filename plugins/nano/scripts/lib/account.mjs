// NanoGPT account helpers: a lightweight liveness ping against the messages
// endpoint and a subscription usage reader. Both are defensive (never throw)
// and scrub the API key out of every returned string, mirroring the fetch +
// AbortController timeout pattern used in models.mjs.

import { DEFAULT_BASE_URL } from "./runtime.mjs";

/**
 * Remove every occurrence of `apiKey` from `value`, defensively, regardless of
 * type. Falls back to String(value) for non-strings.
 */
function scrubKey(value, apiKey) {
  if (!apiKey) return value;
  const str = typeof value === "string" ? value : String(value ?? "");
  return str.replaceAll(apiKey, "***");
}

function firstBodySnippet(body) {
  const str = typeof body === "string" ? body : String(body ?? "");
  return str.slice(0, 200);
}

/**
 * Ping the NanoGPT messages endpoint with a minimal "Reply with OK." request.
 * Never throws. Returns `{ ok, status, model, text, usage, cost, detail }`.
 *
 * `ok` is true only for an HTTP 2xx response whose JSON body has `type:
 * "message"`. `text` is the concatenation of all `text` content blocks
 * (trimmed, truncated to 200 chars). `cost` is `usage.cost` when it is a
 * number, else null. `detail` is a short human string and never contains the
 * API key.
 */
export async function pingNanoGpt({
  apiKey,
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60000
} = {}) {
  const base = baseUrl ?? DEFAULT_BASE_URL;

  if (!apiKey) {
    return { ok: false, status: null, model: model ?? null, text: null, usage: null, cost: null, detail: "no API key" };
  }

  const url = `${base}/v1/messages`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
  const body = JSON.stringify({
    model: model ?? "z-ai/glm-5.2",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with OK." }]
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
  } catch (error) {
    const msg = scrubKey(error?.message ?? String(error), apiKey);
    return {
      ok: false,
      status: null,
      model: model ?? null,
      text: null,
      usage: null,
      cost: null,
      detail: `request failed: ${msg}`
    };
  } finally {
    clearTimeout(timer);
  }

  const status = response ? response.status : 0;

  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }

  if (!response || !response.ok) {
    return {
      ok: false,
      status,
      model: model ?? null,
      text: null,
      usage: null,
      cost: null,
      detail: `HTTP ${status}: ${scrubKey(firstBodySnippet(rawBody), apiKey)}`
    };
  }

  let parsed;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object" || parsed.type !== "message") {
    return {
      ok: false,
      status,
      model: model ?? null,
      text: null,
      usage: null,
      cost: null,
      detail: `HTTP ${status}: ${scrubKey(firstBodySnippet(rawBody), apiKey)}`
    };
  }

  const textBlocks = Array.isArray(parsed.content)
    ? parsed.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text)
    : [];
  let text = textBlocks.join("").trim();
  if (text.length > 200) text = text.slice(0, 200);

  const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
  const cost = usage && typeof usage.cost === "number" ? usage.cost : null;

  return {
    ok: true,
    status,
    model: parsed.model ?? model ?? null,
    text,
    usage,
    cost,
    detail: `HTTP ${status}, replied "${scrubKey(text, apiKey)}"`
  };
}

/**
 * Read NanoGPT subscription usage. Never throws. Returns
 * `{ ok, active, allowOverage, weeklyLimit, weeklyUsed, weeklyRemaining,
 * resetAt, periodEnd, detail }` with numbers or null and ISO strings or null.
 *
 * `ok` is true for an HTTP 2xx with a JSON object body. Account identifiers
 * (provider, stripeSubscriptionId, ...) are deliberately not returned.
 */
export async function fetchSubscriptionUsage({
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  const base = baseUrl ?? DEFAULT_BASE_URL;

  if (!apiKey) {
    return {
      ok: false,
      active: null,
      allowOverage: null,
      weeklyLimit: null,
      weeklyUsed: null,
      weeklyRemaining: null,
      resetAt: null,
      periodEnd: null,
      detail: "no API key"
    };
  }

  const url = `${base}/subscription/v1/usage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: controller.signal
    });
  } catch (error) {
    const msg = scrubKey(error?.message ?? String(error), apiKey);
    return {
      ok: false,
      active: null,
      allowOverage: null,
      weeklyLimit: null,
      weeklyUsed: null,
      weeklyRemaining: null,
      resetAt: null,
      periodEnd: null,
      detail: `request failed: ${msg}`
    };
  } finally {
    clearTimeout(timer);
  }

  const status = response ? response.status : 0;

  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }

  if (!response || !response.ok) {
    return {
      ok: false,
      active: null,
      allowOverage: null,
      weeklyLimit: null,
      weeklyUsed: null,
      weeklyRemaining: null,
      resetAt: null,
      periodEnd: null,
      detail: `HTTP ${status}: ${scrubKey(firstBodySnippet(rawBody), apiKey)}`
    };
  }

  let parsed;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      active: null,
      allowOverage: null,
      weeklyLimit: null,
      weeklyUsed: null,
      weeklyRemaining: null,
      resetAt: null,
      periodEnd: null,
      detail: `HTTP ${status}: ${scrubKey(firstBodySnippet(rawBody), apiKey)}`
    };
  }

  const limits = parsed.limits && typeof parsed.limits === "object" ? parsed.limits : {};
  const weekly = parsed.weeklyInputTokens && typeof parsed.weeklyInputTokens === "object" ? parsed.weeklyInputTokens : {};
  const period = parsed.period && typeof parsed.period === "object" ? parsed.period : {};

  return {
    ok: true,
    active: parsed.active === true,
    allowOverage: parsed.allowOverage === true,
    weeklyLimit: typeof limits.weeklyInputTokens === "number" ? limits.weeklyInputTokens : null,
    weeklyUsed: typeof weekly.used === "number" ? weekly.used : null,
    weeklyRemaining: typeof weekly.remaining === "number" ? weekly.remaining : null,
    resetAt: typeof weekly.resetAt === "number" ? new Date(weekly.resetAt).toISOString() : null,
    periodEnd: typeof period.currentPeriodEnd === "string" ? period.currentPeriodEnd : null,
    detail: `HTTP ${status}`
  };
}

/**
 * Format a token count for human display: "57.8M", "2.2M", "950k", "12".
 * Non-numbers yield "?".
 */
export function formatTokenCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return `${Math.round(n)}`;
}

/**
 * Combine the subscription usage snapshots taken just before and just after a
 * claude run into a per-run quota object:
 * `{ delta, weeklyUsed, weeklyLimit, weekPercent }`.
 *
 * `delta` is the change in `weeklyUsed` across the run (null unless both
 * snapshots succeeded with numbers; it can be negative only when the weekly
 * window reset mid-run). `weekPercent` is the after-snapshot usage as a
 * whole-percent of the weekly limit (null when not computable). Returns null
 * when the after-snapshot failed — a quota read must never fail the run.
 */
export function buildRunQuota(before, after) {
  if (!after || after.ok !== true) {
    return null;
  }
  const weeklyUsed = typeof after.weeklyUsed === "number" ? after.weeklyUsed : null;
  const weeklyLimit = typeof after.weeklyLimit === "number" ? after.weeklyLimit : null;
  let delta = null;
  if (before && before.ok === true && typeof before.weeklyUsed === "number" && typeof after.weeklyUsed === "number") {
    delta = after.weeklyUsed - before.weeklyUsed;
  }
  let weekPercent = null;
  if (typeof after.weeklyUsed === "number" && typeof after.weeklyLimit === "number" && after.weeklyLimit > 0) {
    weekPercent = Math.round((after.weeklyUsed / after.weeklyLimit) * 100);
  }
  return { delta, weeklyUsed, weeklyLimit, weekPercent };
}

/**
 * Render a one-line subscription summary from a fetchSubscriptionUsage
 * result. Examples:
 *   active, 2.2M of 60.0M weekly input tokens used (57.8M left, resets <iso>)
 *   inactive
 *   unavailable (<detail>)
 */
export function describeSubscription(usage) {
  if (!usage || !usage.ok) {
    return `unavailable (${usage?.detail ?? "unknown"})`;
  }
  if (!usage.active) {
    return "inactive";
  }
  const used = formatTokenCount(usage.weeklyUsed);
  const limit = formatTokenCount(usage.weeklyLimit);
  const left = formatTokenCount(usage.weeklyRemaining);
  const resets = usage.resetAt ?? "?";
  return `active, ${used} of ${limit} weekly input tokens used (${left} left, resets ${resets})`;
}
