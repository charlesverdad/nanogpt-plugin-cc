import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL,
  MODEL_ALIASES,
  BUILTIN_CATALOG,
  CATALOG_TTL_MS,
  resolveCatalogCacheFile,
  normalizeCatalog,
  fetchModelCatalog,
  loadModelCatalog,
  resolveModelAlias,
  includedAlternatives,
  resolveModelSelection,
  describeAliases
} from "../plugins/nano/scripts/lib/models.mjs";

const BASE_URL = "https://nano-gpt.com/api";

function tempEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nano-models-"));
  return { CLAUDE_PLUGIN_DATA: dir };
}

function okResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function errResponse(status, body = "nope") {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => body
  };
}

function recordingFetch(data, capture) {
  return async (url, options) => {
    if (capture) {
      capture.url = url;
      capture.options = options;
    }
    return okResponse(data);
  };
}

function authenticatedData(overrides = []) {
  return {
    object: "list",
    data: [
      {
        id: "z-ai/glm-5.2",
        context_length: 1048576,
        capabilities: { tool_calling: true, reasoning: true },
        subscription: { included: true, inputTokenMultiplier: 1, note: "Included in subscription" }
      },
      {
        id: "z-ai/glm-5.2:thinking",
        context_length: 1048576,
        capabilities: { tool_calling: true, reasoning: true },
        subscription: { included: true, inputTokenMultiplier: 1, note: "Included in subscription" }
      },
      {
        id: "z-ai/glm-5.3",
        context_length: 1048576,
        capabilities: { tool_calling: true, reasoning: true },
        subscription: { included: true, inputTokenMultiplier: 2, note: "Included in subscription" }
      },
      {
        id: "minimax/minimax-m3",
        context_length: 512000,
        capabilities: { tool_calling: true },
        subscription: { included: true, inputTokenMultiplier: 1 }
      },
      ...overrides
    ]
  };
}

function catalogWith(models, source = "builtin") {
  return { models, source };
}

// ---------------------------------------------------------------------------
// constants & aliases
// ---------------------------------------------------------------------------

test("DEFAULT_MODEL is z-ai/glm-5.2", () => {
  assert.equal(DEFAULT_MODEL, "z-ai/glm-5.2");
});

test("MODEL_ALIASES is frozen with the verified targets", () => {
  assert.equal(Object.isFrozen(MODEL_ALIASES), true);
  assert.deepEqual(MODEL_ALIASES, {
    default: "z-ai/glm-5.2",
    heavy: "z-ai/glm-5.3",
    alt: "minimax/minimax-m3",
    fast: "z-ai/glm-5.3-flash"
  });
});

test("BUILTIN_CATALOG is a frozen array of frozen objects with the verified entries", () => {
  assert.equal(Object.isFrozen(BUILTIN_CATALOG), true);
  assert.equal(BUILTIN_CATALOG.every((m) => Object.isFrozen(m)), true);
  const ids = BUILTIN_CATALOG.map((m) => m.id);
  assert.deepEqual(ids, [
    "z-ai/glm-5.2",
    "z-ai/glm-5.2:thinking",
    "z-ai/glm-5.3",
    "z-ai/glm-5.3:thinking",
    "minimax/minimax-m3",
    "z-ai/glm-5.3-flash",
    "qwen/qwen3.8-27b",
    "qwen/qwen3.8-27b:thinking",
    "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4.1-flash"
  ]);
  for (const m of BUILTIN_CATALOG) {
    assert.equal(m.included, true);
    assert.equal(m.toolCalling, true);
  }
  assert.deepEqual(
    BUILTIN_CATALOG.find((m) => m.id === "z-ai/glm-5.3"),
    { id: "z-ai/glm-5.3", included: true, multiplier: 2, contextLength: 1048576, toolCalling: true }
  );
  assert.deepEqual(
    BUILTIN_CATALOG.find((m) => m.id === "minimax/minimax-m3"),
    { id: "minimax/minimax-m3", included: true, multiplier: 1, contextLength: 512000, toolCalling: true }
  );
  assert.equal(BUILTIN_CATALOG.find((m) => m.id === "qwen/qwen3.8-27b").contextLength, 262144);
  assert.equal(BUILTIN_CATALOG.find((m) => m.id === "deepseek/deepseek-v4.1-flash").contextLength, 1000000);
});

test("CATALOG_TTL_MS is 24 hours", () => {
  assert.equal(CATALOG_TTL_MS, 24 * 60 * 60 * 1000);
});

test("resolveCatalogCacheFile honors CLAUDE_PLUGIN_DATA", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/tmp/nano-data" };
  assert.equal(resolveCatalogCacheFile(env), path.join("/tmp/nano-data", "models-cache.json"));
});

test("resolveCatalogCacheFile falls back to a per-user tmpdir/nano-companion-<uid>", () => {
  const file = resolveCatalogCacheFile({});
  const owner = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  assert.equal(file, path.join(os.tmpdir(), `nano-companion-${owner}`, "models-cache.json"));
});

// ---------------------------------------------------------------------------
// resolveModelAlias
// ---------------------------------------------------------------------------

test("resolveModelAlias: known aliases resolve to their targets", () => {
  assert.equal(resolveModelAlias("default"), "z-ai/glm-5.2");
  assert.equal(resolveModelAlias("heavy"), "z-ai/glm-5.3");
  assert.equal(resolveModelAlias("alt"), "minimax/minimax-m3");
  assert.equal(resolveModelAlias("fast"), "z-ai/glm-5.3-flash");
});

test("resolveModelAlias: full ids pass through unchanged (trimmed)", () => {
  assert.equal(resolveModelAlias("z-ai/glm-5.2"), "z-ai/glm-5.2");
  assert.equal(resolveModelAlias("  z-ai/glm-5.3  "), "z-ai/glm-5.3");
  assert.equal(resolveModelAlias("vendor/some-model:thinking"), "vendor/some-model:thinking");
});

test("resolveModelAlias: empty / null / undefined -> default", () => {
  assert.equal(resolveModelAlias(""), MODEL_ALIASES.default);
  assert.equal(resolveModelAlias("   "), MODEL_ALIASES.default);
  assert.equal(resolveModelAlias(null), MODEL_ALIASES.default);
  assert.equal(resolveModelAlias(undefined), MODEL_ALIASES.default);
});

test("describeAliases: lists each alias → target", () => {
  const list = describeAliases();
  assert.deepEqual(list, [
    "default → z-ai/glm-5.2",
    "heavy → z-ai/glm-5.3",
    "alt → minimax/minimax-m3",
    "fast → z-ai/glm-5.3-flash"
  ]);
});

// ---------------------------------------------------------------------------
// normalizeCatalog
// ---------------------------------------------------------------------------

test("normalizeCatalog: authenticated shape yields normalized entries", () => {
  const out = normalizeCatalog(authenticatedData());
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], {
    id: "z-ai/glm-5.2",
    included: true,
    multiplier: 1,
    contextLength: 1048576,
    toolCalling: true
  });
  assert.deepEqual(out[2], {
    id: "z-ai/glm-5.3",
    included: true,
    multiplier: 2,
    contextLength: 1048576,
    toolCalling: true
  });
});

test("normalizeCatalog: unauthenticated shape (no subscription) -> null", () => {
  const unauth = {
    object: "list",
    data: [
      { id: "z-ai/glm-5.2", context_length: 1048576, capabilities: { tool_calling: true } },
      { id: "z-ai/glm-5.3", context_length: 1048576, capabilities: { tool_calling: true } }
    ]
  };
  assert.equal(normalizeCatalog(unauth), null);
});

test("normalizeCatalog: non-array data -> null", () => {
  assert.equal(normalizeCatalog({ data: "nope" }), null);
  assert.equal(normalizeCatalog({}), null);
});

test("normalizeCatalog: empty data array -> null", () => {
  assert.equal(normalizeCatalog({ data: [] }), null);
});

test("normalizeCatalog: entries without a string id are skipped; missing fields default", () => {
  const out = normalizeCatalog({
    data: [
      { id: "vendor/x", subscription: { included: false, inputTokenMultiplier: 3 } },
      { notId: true, subscription: { included: true } }
    ]
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: "vendor/x",
    included: false,
    multiplier: 3,
    contextLength: null,
    toolCalling: null
  });
});

// ---------------------------------------------------------------------------
// fetchModelCatalog
// ---------------------------------------------------------------------------

test("fetchModelCatalog: sends x-api-key header and the detailed URL", async () => {
  const capture = {};
  const fetchImpl = recordingFetch(authenticatedData(), capture);
  await fetchModelCatalog({ apiKey: "SECRET-KEY", baseUrl: BASE_URL, fetchImpl });
  assert.equal(capture.url, `${BASE_URL}/v1/models?detailed=true`);
  assert.equal(capture.options.headers["x-api-key"], "SECRET-KEY");
  assert.equal(capture.options.headers.accept, "application/json");
});

test("fetchModelCatalog: throws on 401 without leaking the key in the message", async () => {
  const fetchImpl = async () => errResponse(401);
  await assert.rejects(
    fetchModelCatalog({ apiKey: "SECRET-KEY", baseUrl: BASE_URL, fetchImpl }),
    (err) => {
      assert.match(err.message, /401/);
      assert.equal(err.message.includes("SECRET-KEY"), false, "key leaked in error message");
      return true;
    }
  );
});

test("fetchModelCatalog: throws without apiKey before fetching", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return okResponse(authenticatedData());
  };
  await assert.rejects(
    fetchModelCatalog({ baseUrl: BASE_URL, fetchImpl }),
    /API key/
  );
  assert.equal(called, false, "fetch was called despite missing apiKey");
});

test("fetchModelCatalog: throws on invalid JSON", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("bad json");
    },
    text: async () => "not json"
  });
  await assert.rejects(
    fetchModelCatalog({ apiKey: "K", baseUrl: BASE_URL, fetchImpl }),
    /not valid JSON/
  );
});

test("fetchModelCatalog: throws when normalizeCatalog returns null (unauthenticated)", async () => {
  const fetchImpl = async () =>
    okResponse({
      data: [{ id: "z-ai/glm-5.2", context_length: 1048576, capabilities: {} }]
    });
  await assert.rejects(
    fetchModelCatalog({ apiKey: "K", baseUrl: BASE_URL, fetchImpl }),
    /unusable/
  );
});

// ---------------------------------------------------------------------------
// loadModelCatalog
// ---------------------------------------------------------------------------

test("loadModelCatalog: network success writes cache; second call returns cache without fetching", async () => {
  const env = tempEnv();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse(authenticatedData());
  };
  const first = await loadModelCatalog({ apiKey: "SECRET-KEY", baseUrl: BASE_URL, env, fetchImpl, now: 1000 });
  assert.equal(first.source, "network");
  assert.equal(first.models.length, 4);
  assert.equal(first.error, null);
  assert.equal(calls, 1);

  const cacheFile = resolveCatalogCacheFile(env);
  const raw = readFileSync(cacheFile, "utf8");
  assert.equal(raw.includes("SECRET-KEY"), false, "cache file contains the apiKey");

  const second = await loadModelCatalog({ apiKey: "SECRET-KEY", baseUrl: BASE_URL, env, fetchImpl, now: 1000 });
  assert.equal(second.source, "cache");
  assert.equal(calls, 1, "fetch was called again for a fresh cache hit");
  assert.deepEqual(second.models, first.models);
});

test("loadModelCatalog: cache expires after maxAgeMs and refetches", async () => {
  const env = tempEnv();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse(authenticatedData());
  };
  await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl, now: 1000, maxAgeMs: 1000 });
  assert.equal(calls, 1);
  const second = await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl, now: 2000, maxAgeMs: 1000 });
  assert.equal(second.source, "network");
  assert.equal(calls, 2);
});

test("loadModelCatalog: refresh:true refetches even with a fresh cache", async () => {
  const env = tempEnv();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse(authenticatedData());
  };
  await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl, now: 1000 });
  assert.equal(calls, 1);
  const second = await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl, now: 1000, refresh: true });
  assert.equal(second.source, "network");
  assert.equal(calls, 2);
});

test("loadModelCatalog: fetch failure with an existing cache -> stale-cache", async () => {
  const env = tempEnv();
  let calls = 0;
  const goodFetch = async () => {
    calls += 1;
    return okResponse(authenticatedData());
  };
  await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl: goodFetch, now: 1000 });
  const failingFetch = async () => {
    throw new Error("network down");
  };
  const result = await loadModelCatalog({
    apiKey: "K",
    baseUrl: BASE_URL,
    env,
    fetchImpl: failingFetch,
    now: 9999,
    refresh: true
  });
  assert.equal(result.source, "stale-cache");
  assert.equal(result.models.length, 4);
  assert.match(result.error, /network down/);
});

test("loadModelCatalog: fetch failure without a cache -> builtin with error set", async () => {
  const env = tempEnv();
  const failingFetch = async () => {
    throw new Error("network down");
  };
  const result = await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl: failingFetch, now: 1000 });
  assert.equal(result.source, "builtin");
  assert.deepEqual(result.models, BUILTIN_CATALOG);
  assert.match(result.error, /network down/);
});

test("loadModelCatalog: cache for a different baseUrl is ignored", async () => {
  const env = tempEnv();
  const goodFetch = async () => okResponse(authenticatedData());
  await loadModelCatalog({ apiKey: "K", baseUrl: BASE_URL, env, fetchImpl: goodFetch, now: 1000 });

  const failingFetch = async () => {
    throw new Error("other base unreachable");
  };
  const result = await loadModelCatalog({
    apiKey: "K",
    baseUrl: "https://other.example.com/api",
    env,
    fetchImpl: failingFetch,
    now: 1000
  });
  // baseUrl mismatch => cache not reused as stale-cache => builtin fallback
  assert.equal(result.source, "builtin");
  assert.match(result.error, /other base unreachable/);
});

test("loadModelCatalog: never throws (missing apiKey falls back to builtin)", async () => {
  const env = tempEnv();
  const result = await loadModelCatalog({ baseUrl: BASE_URL, env, now: 1000 });
  assert.equal(result.source, "builtin");
  assert.ok(result.error, "expected an error message for missing apiKey");
});

// ---------------------------------------------------------------------------
// includedAlternatives
// ---------------------------------------------------------------------------

test("includedAlternatives: alias targets first (present+included), then others, capped at count", () => {
  const cat = catalogWith(BUILTIN_CATALOG);
  const alts = includedAlternatives(cat, 3);
  // alias order: default=glm-5.2, heavy=glm-5.3, alt=minimax-m3, fast=glm-5.3-flash
  assert.deepEqual(alts, ["z-ai/glm-5.2", "z-ai/glm-5.3", "minimax/minimax-m3"]);
});

test("includedAlternatives: excludes thinking variants", () => {
  const cat = catalogWith(BUILTIN_CATALOG);
  const alts = includedAlternatives(cat, 100);
  assert.equal(alts.some((id) => id.endsWith(":thinking")), false);
});

test("includedAlternatives: count default is 3", () => {
  const cat = catalogWith(BUILTIN_CATALOG);
  assert.equal(includedAlternatives(cat).length, 3);
});

// ---------------------------------------------------------------------------
// resolveModelSelection
// ---------------------------------------------------------------------------

test("resolveModelSelection: default model resolves with no warnings", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model, warnings } = resolveModelSelection({ catalog: cat });
  assert.equal(model, "z-ai/glm-5.2");
  assert.deepEqual(warnings, []);
});

test("resolveModelSelection: alias heavy -> glm-5.3 with a 2x quota warning", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model, warnings } = resolveModelSelection({ requested: "heavy", catalog: cat });
  assert.equal(model, "z-ai/glm-5.3");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2×/);
});

test("resolveModelSelection: thinking variant chosen when present", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model, warnings } = resolveModelSelection({ requested: "z-ai/glm-5.2", thinking: true, catalog: cat });
  assert.equal(model, "z-ai/glm-5.2:thinking");
  assert.deepEqual(warnings, []);
});

test("resolveModelSelection: warning when thinking variant absent (glm-5.3-flash)", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model, warnings } = resolveModelSelection({ requested: "fast", thinking: true, catalog: cat });
  assert.equal(model, "z-ai/glm-5.3-flash");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No z-ai\/glm-5.3-flash:thinking variant/);
  assert.match(warnings[0], /running z-ai\/glm-5.3-flash without thinking/);
});

test("resolveModelSelection: paid model throws naming 3 included alternatives and --allow-paid", () => {
  const cat = catalogWith(
    [
      ...BUILTIN_CATALOG,
      { id: "anthropic/claude-sonnet-5", included: false, multiplier: 1, contextLength: 200000, toolCalling: true }
    ],
    "network"
  );
  assert.throws(
    () => resolveModelSelection({ requested: "anthropic/claude-sonnet-5", catalog: cat }),
    (err) => {
      assert.match(err.message, /not included in your NanoGPT subscription/);
      assert.match(err.message, /--allow-paid/);
      // names 3 included alternatives
      assert.match(err.message, /z-ai\/glm-5.2, z-ai\/glm-5.3, minimax\/minimax-m3/);
      return true;
    }
  );
});

test("resolveModelSelection: allowPaid turns a paid model into a warning", () => {
  const cat = catalogWith(
    [
      ...BUILTIN_CATALOG,
      { id: "anthropic/claude-sonnet-5", included: false, multiplier: 1, contextLength: 200000, toolCalling: true }
    ],
    "network"
  );
  const { model, warnings } = resolveModelSelection({
    requested: "anthropic/claude-sonnet-5",
    allowPaid: true,
    catalog: cat
  });
  assert.equal(model, "anthropic/claude-sonnet-5");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not included in the NanoGPT subscription/);
  assert.match(warnings[0], /--allow-paid/);
});

test("resolveModelSelection: unknown model throws unless allowPaid", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  assert.throws(
    () => resolveModelSelection({ requested: "nope/missing", catalog: cat }),
    (err) => {
      assert.match(err.message, /Unknown NanoGPT model "nope\/missing"/);
      assert.match(err.message, /Try one of:/);
      assert.match(err.message, /--allow-paid/);
      return true;
    }
  );
  const { model, warnings } = resolveModelSelection({ requested: "nope/missing", allowPaid: true, catalog: cat });
  assert.equal(model, "nope/missing");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not in the NanoGPT catalog/);
  assert.match(warnings[0], /--allow-paid/);
});

test("resolveModelSelection: configModel used when requested is empty", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model, warnings } = resolveModelSelection({ requested: "", configModel: "heavy", catalog: cat });
  assert.equal(model, "z-ai/glm-5.3");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2×/);
});

test("resolveModelSelection: requested beats configModel", () => {
  const cat = catalogWith(BUILTIN_CATALOG, "builtin");
  const { model } = resolveModelSelection({ requested: "fast", configModel: "heavy", catalog: cat });
  assert.equal(model, "z-ai/glm-5.3-flash");
});
