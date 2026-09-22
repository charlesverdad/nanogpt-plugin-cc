// NanoGPT model catalog: alias resolution, catalog fetching/caching and
// model selection.
//
// NanoGPT exposes `GET {baseUrl}/v1/models?detailed=true`. Authenticated
// requests (header `x-api-key`) embed a `subscription` object per model; the
// same route without the header omits `subscription`, which must be treated as
// unusable (every model would otherwise look paid). This module keeps a small
// verified builtin catalog for offline/fallback use and a 24h on-disk cache
// keyed by baseUrl. The API key is never persisted to the cache.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BASE_URL } from "./runtime.mjs";

export const DEFAULT_MODEL = "z-ai/glm-5.2";

export const MODEL_ALIASES = Object.freeze({
  default: "z-ai/glm-5.2",
  heavy: "z-ai/glm-5.3",
  alt: "minimax/minimax-m3",
  fast: "z-ai/glm-5.3-flash"
});

function freezeEntry(entry) {
  return Object.freeze({
    id: entry.id,
    included: entry.included,
    multiplier: entry.multiplier,
    contextLength: entry.contextLength,
    toolCalling: entry.toolCalling
  });
}

const BUILTIN_RAW = [
  { id: "z-ai/glm-5.2", multiplier: 1, contextLength: 1048576 },
  { id: "z-ai/glm-5.2:thinking", multiplier: 1, contextLength: 1048576 },
  { id: "z-ai/glm-5.3", multiplier: 2, contextLength: 1048576 },
  { id: "z-ai/glm-5.3:thinking", multiplier: 2, contextLength: 1048576 },
  { id: "minimax/minimax-m3", multiplier: 1, contextLength: 512000 },
  { id: "z-ai/glm-5.3-flash", multiplier: 1, contextLength: 1048576 },
  { id: "qwen/qwen3.8-27b", multiplier: 1, contextLength: 262144 },
  { id: "qwen/qwen3.8-27b:thinking", multiplier: 1, contextLength: 262144 },
  { id: "deepseek/deepseek-v4-pro-0813", multiplier: 2, contextLength: 1048576 },
  { id: "deepseek/deepseek-v4.1-flash", multiplier: 1, contextLength: 1000000 }
];

export const BUILTIN_CATALOG = Object.freeze(
  BUILTIN_RAW.map((entry) =>
    freezeEntry({
      id: entry.id,
      included: true,
      multiplier: entry.multiplier,
      contextLength: entry.contextLength,
      toolCalling: true
    })
  )
);

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the on-disk catalog cache file. Honors CLAUDE_PLUGIN_DATA, falling
 * back to a per-user tmp dir, mirroring state.mjs/runs.jsonl.
 */
export function resolveCatalogCacheFile(env = process.env) {
  return path.join(
    env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "nano-companion"),
    "models-cache.json"
  );
}

/**
 * Normalize a raw `{ data: [...] }` catalog payload into a flat array of
 * `{ id, included, multiplier, contextLength, toolCalling }` entries. Returns
 * null when the payload is not usable: missing/empty data array, or an
 * unauthenticated response where no entry carries a `subscription` object.
 */
export function normalizeCatalog(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
    return null;
  }
  if (json.data.length === 0) {
    return null;
  }
  const hasSubscription = json.data.some(
    (m) => m && typeof m === "object" && m.subscription && typeof m.subscription === "object"
  );
  if (!hasSubscription) {
    return null;
  }
  const models = [];
  for (const m of json.data) {
    if (!m || typeof m !== "object" || typeof m.id !== "string") {
      continue;
    }
    models.push({
      id: m.id,
      included: m.subscription?.included === true,
      multiplier: Number(m.subscription?.inputTokenMultiplier) || 1,
      contextLength: m.context_length ?? null,
      toolCalling: m.capabilities?.tool_calling ?? null
    });
  }
  return models;
}

/**
 * Fetch and normalize the NanoGPT model catalog over HTTP. Throws on non-2xx,
 * invalid JSON, or an unusable (unauthenticated) response. The API key is
 * never included in any thrown message.
 */
export async function fetchModelCatalog({
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  if (!apiKey) {
    throw new Error("fetchModelCatalog requires an API key.");
  }
  const url = `${baseUrl}/v1/models?detailed=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response || !response.ok) {
    const status = response ? response.status : 0;
    throw new Error(`NanoGPT catalog request failed with status ${status}.`);
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("NanoGPT catalog response was not valid JSON.");
  }

  const normalized = normalizeCatalog(parsed);
  if (!normalized) {
    throw new Error("NanoGPT catalog response was unusable (no subscription data).");
  }
  return normalized;
}

function readCacheFile(cacheFile) {
  try {
    const raw = readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.fetchedAt === "number" &&
      typeof parsed.baseUrl === "string" &&
      Array.isArray(parsed.models)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCacheFile(cacheFile, entry) {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    // best-effort; cache write failures are non-fatal
  }
}

/**
 * Load the model catalog, preferring a fresh on-disk cache and falling back to
 * the network, a stale cache, or finally the builtin catalog. Never throws.
 * Returns `{ models, source, fetchedAt, error }`.
 */
export async function loadModelCatalog({
  apiKey,
  baseUrl,
  env = process.env,
  fetchImpl,
  now = Date.now(),
  maxAgeMs = CATALOG_TTL_MS,
  refresh = false
} = {}) {
  const cacheFile = resolveCatalogCacheFile(env);
  const cached = readCacheFile(cacheFile);
  const base = baseUrl ?? DEFAULT_BASE_URL;

  if (!refresh && cached && cached.baseUrl === base && now - cached.fetchedAt < maxAgeMs) {
    return {
      models: cached.models,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      error: null
    };
  }

  try {
    const models = await fetchModelCatalog({ apiKey, baseUrl: base, fetchImpl });
    const entry = { fetchedAt: now, baseUrl: base, models };
    writeCacheFile(cacheFile, entry);
    return { models, source: "network", fetchedAt: now, error: null };
  } catch (error) {
    if (cached && cached.baseUrl === base) {
      return {
        models: cached.models,
        source: "stale-cache",
        fetchedAt: cached.fetchedAt,
        error: error?.message ?? String(error)
      };
    }
    return {
      models: BUILTIN_CATALOG,
      source: "builtin",
      fetchedAt: now,
      error: error?.message ?? String(error)
    };
  }
}

/**
 * Resolve a model alias to a concrete id. Empty/null/undefined yields the
 * default alias target; unknown values pass through unchanged.
 */
export function resolveModelAlias(value) {
  if (value === null || value === undefined) {
    return MODEL_ALIASES.default;
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return MODEL_ALIASES.default;
  }
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, trimmed)) {
    return MODEL_ALIASES[trimmed];
  }
  return trimmed;
}

/**
 * Return up to `count` ids of included, non-thinking models, alias targets
 * first (in MODEL_ALIASES order) then any others.
 */
export function includedAlternatives(catalog, count = 3) {
  const models = catalog?.models ?? [];
  const included = models.filter((m) => m && m.included === true && !String(m.id).endsWith(":thinking"));
  const byId = new Map(included.map((m) => [m.id, m]));

  const result = [];
  const seen = new Set();
  for (const target of Object.values(MODEL_ALIASES)) {
    if (byId.has(target) && !seen.has(target)) {
      result.push(target);
      seen.add(target);
    }
    if (result.length >= count) {
      return result;
    }
  }
  for (const m of included) {
    if (!seen.has(m.id)) {
      result.push(m.id);
      seen.add(m.id);
    }
    if (result.length >= count) {
      break;
    }
  }
  return result;
}

/**
 * Resolve a model selection request against a loaded catalog. Returns
 * `{ model, warnings }` or throws an Error naming included alternatives and
 * (where relevant) the --allow-paid flag.
 */
export function resolveModelSelection({
  requested,
  configModel,
  thinking = false,
  allowPaid = false,
  catalog
} = {}) {
  const warnings = [];
  const name = resolveModelAlias(requested || configModel || "default");
  let model = name;

  const models = catalog?.models ?? [];

  if (thinking) {
    if (!model.endsWith(":thinking")) {
      const variant = `${model}:thinking`;
      if (models.some((m) => m.id === variant)) {
        model = variant;
      } else {
        warnings.push(`No ${model}:thinking variant in the NanoGPT catalog; running ${model} without thinking.`);
      }
    }
  }

  const entry = models.find((m) => m.id === model);
  const alts = includedAlternatives(catalog);

  if (!entry) {
    if (allowPaid) {
      warnings.push(
        `${model} is not in the NanoGPT catalog (${catalog?.source ?? "unknown"}); running anyway because --allow-paid was given.`
      );
    } else {
      throw new Error(
        `Unknown NanoGPT model "${model}" (catalog source: ${catalog?.source ?? "unknown"}). Try one of: ${alts.join(", ")}, or pass --allow-paid to run it anyway.`
      );
    }
  } else if (entry.included !== true) {
    if (allowPaid) {
      warnings.push(
        `${model} is not included in the NanoGPT subscription and will be billed per token (--allow-paid).`
      );
    } else {
      throw new Error(
        `${model} is not included in your NanoGPT subscription and would be billed per token. Use an included model such as ${alts.join(", ")}, or pass --allow-paid.`
      );
    }
  } else if (entry.multiplier > 1) {
    warnings.push(
      `${model} counts input tokens at ${entry.multiplier}× against your weekly NanoGPT quota.`
    );
  }

  return { model, warnings };
}

/**
 * Human-readable alias descriptions, e.g. `default → z-ai/glm-5.2`, in
 * MODEL_ALIASES insertion order.
 */
export function describeAliases() {
  return Object.entries(MODEL_ALIASES).map(([alias, target]) => `${alias} → ${target}`);
}
