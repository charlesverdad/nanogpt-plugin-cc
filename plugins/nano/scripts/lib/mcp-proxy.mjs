/**
 * Pure helpers for the logging MCP proxy (scripts/nanogpt-mcp-proxy.mjs):
 * line framing, tools/call tracking and rewriting, and log entry building.
 * Nothing here handles the API key.
 */

import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./state.mjs";
import { elideDataUrls, isUsableEnvValue, resolveDataDir, resolveProjectDir } from "./media.mjs";

export const UPSTREAM_VERSION = "1.5.0";
export const DEFAULT_UPSTREAM = Object.freeze(["npx", "-y", `@nanogpt/mcp@${UPSTREAM_VERSION}`]);
export const DEFAULT_TIMEOUT_MS = "300000";
export const SAVE_WAIT_MS = 30_000;
export const PROXY_ID_PREFIX = "nano-proxy-";
export const CALL_LOG_NAME = "mcp-calls.jsonl";
const MAX_TEXT = 500;

const NEWLINE = 0x0a;

/** Splits a byte stream into lines on `\n`, buffering partial lines. No length limit. */
export class LineSplitter {
  constructor() {
    this.chunks = [];
  }

  push(chunk) {
    const lines = [];
    let start = 0;
    for (let i = chunk.indexOf(NEWLINE, start); i !== -1; i = chunk.indexOf(NEWLINE, start)) {
      this.chunks.push(chunk.subarray(start, i));
      lines.push(Buffer.concat(this.chunks));
      this.chunks = [];
      start = i + 1;
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start));
    }
    return lines;
  }

  /** The trailing unterminated line, if any. */
  flush() {
    if (this.chunks.length === 0) {
      return null;
    }
    const line = Buffer.concat(this.chunks);
    this.chunks = [];
    return line.length > 0 ? line : null;
  }
}

export function parseUpstreamCommand(env = process.env) {
  const raw = String(env.NANO_MCP_UPSTREAM ?? "").trim();
  if (!raw) {
    return [...DEFAULT_UPSTREAM];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NANO_MCP_UPSTREAM must be a JSON array of a command and its arguments");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string")) {
    throw new Error("NANO_MCP_UPSTREAM must be a non-empty JSON array of strings");
  }
  return parsed;
}

/** Environment for the upstream child. The key goes in only here. */
export function buildChildEnv(env, key) {
  return {
    ...env,
    NANOGPT_API_KEY: key,
    NANOGPT_TIMEOUT_MS: String(env.NANOGPT_TIMEOUT_MS ?? "").trim() || DEFAULT_TIMEOUT_MS
  };
}

export function idKey(id) {
  return `${typeof id}:${id}`;
}

function tryParse(line) {
  try {
    const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Calls the client has made that are still waiting for an upstream response. */
export class CallTracker {
  constructor() {
    this.calls = new Map();
  }

  record(id, tool, args, startedAt) {
    this.calls.set(idKey(id), { id, tool, args, startedAt });
  }

  take(id) {
    const key = idKey(id);
    const call = this.calls.get(key);
    this.calls.delete(key);
    return call ?? null;
  }

  remaining() {
    const all = [...this.calls.values()];
    this.calls.clear();
    return all;
  }
}

/**
 * Inspect one client-to-upstream line.
 *
 * @returns {{ line: Buffer | string, cancelled: object | null }} the line to forward,
 *   and a tracked call that the client cancelled (already removed from the tracker).
 */
export function processClientLine(line, tracker, now = Date.now()) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const wantsCall = text.includes("tools/call");
  const wantsCancel = text.includes("notifications/cancelled");
  if (!wantsCall && !wantsCancel) {
    return { line, cancelled: null };
  }
  const msg = tryParse(text);
  if (!msg) {
    return { line, cancelled: null };
  }
  if (msg.method === "tools/call" && msg.id !== undefined && msg.id !== null) {
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    const tool = String(params.name ?? "");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    tracker.record(msg.id, tool, args, now);
    if (tool === "nanogpt_chat" && args.include_usage === undefined) {
      params.arguments = { ...args, include_usage: true };
      msg.params = params;
      return { line: JSON.stringify(msg), cancelled: null };
    }
    return { line, cancelled: null };
  }
  if (msg.method === "notifications/cancelled" && msg.params?.requestId !== undefined) {
    return { line, cancelled: tracker.take(msg.params.requestId) };
  }
  return { line, cancelled: null };
}

/** Classify an upstream-to-client line: `proxy` (ours), `response` (to a recorded call), or `other`. */
export function classifyUpstreamLine(line, tracker) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  if (!text.includes('"id"')) {
    return { kind: "other" };
  }
  const msg = tryParse(text);
  if (!msg || msg.id === undefined || msg.id === null || msg.method) {
    return { kind: "other" };
  }
  if (typeof msg.id === "string" && msg.id.startsWith(PROXY_ID_PREFIX)) {
    return { kind: "proxy", msg };
  }
  const call = tracker.take(msg.id);
  return call ? { kind: "response", msg, call } : { kind: "other" };
}

function clip(text, max = MAX_TEXT) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) : value;
}

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/** Args summary for the call log: long text truncated, data URLs elided. */
export function summarizeArgs(args) {
  const elided = elideDataUrls(args ?? {});
  const out = {};
  for (const [key, value] of Object.entries(elided)) {
    if (key === "prompt" && typeof value === "string") {
      out.prompt = clip(value);
    } else if (key === "messages" && Array.isArray(value)) {
      out.messages = value.map((message) =>
        message && typeof message === "object"
          ? { ...message, content: clip(messageText(message.content)) }
          : message
      );
    } else if (typeof value === "string") {
      out[key] = clip(value, 2000);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function countPromptChars(args) {
  let total = typeof args?.prompt === "string" ? args.prompt.length : 0;
  if (Array.isArray(args?.messages)) {
    for (const message of args.messages) {
      total += messageText(message?.content).length;
    }
  }
  return total;
}

function findCost(msg) {
  const structured = msg.result?.structuredContent;
  const candidates = [structured?.cost, structured?.usage?.cost, structured?.usage?.total_cost, msg.result?.cost, structured?.raw?.usage?.cost];
  for (const value of candidates) {
    if (typeof value === "number" || (value && typeof value === "object")) {
      return value;
    }
  }
  return null;
}

function errorText(msg) {
  if (msg.error) {
    return clip(msg.error.message ?? JSON.stringify(msg.error));
  }
  if (msg.result?.isError) {
    const text = (msg.result.content ?? []).map((part) => part?.text ?? "").filter(Boolean).join(" ");
    return clip(text || "tool reported an error");
  }
  return null;
}

/**
 * Build one call-log entry. `msg` is the upstream response (or null for a
 * cancelled call); `media` is the list of saved files, `extraError` an
 * additional failure note such as a failed image download.
 */
export function buildLogEntry({ call, msg, now = Date.now(), env = process.env, media = [], extraError = null, cancelled = false }) {
  const error = cancelled ? "cancelled" : errorText(msg ?? {}) ?? (extraError ? clip(extraError) : null);
  const usage = msg?.result?.structuredContent?.usage;
  return {
    ts: new Date(now).toISOString(),
    tool: call.tool,
    ok: !cancelled && !msg?.error && !msg?.result?.isError,
    ms: Math.max(0, now - call.startedAt),
    model: typeof call.args?.model === "string" ? call.args.model : null,
    usage: usage && typeof usage === "object" ? usage : null,
    cost: msg ? findCost(msg) : null,
    error,
    media,
    promptChars: countPromptChars(call.args),
    args: summarizeArgs(call.args),
    projectDir: resolveProjectDir(env),
    ...(cancelled ? { cancelled: true } : {})
  };
}

/** Append one JSON line to `<data dir>/mcp-calls.jsonl`. Never throws. */
export function appendCallLog(entry, env = process.env) {
  try {
    const dir = resolveDataDir(env);
    if (isUsableEnvValue(env.CLAUDE_PLUGIN_DATA)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      ensurePrivateDir(dir);
    }
    const file = path.join(dir, CALL_LOG_NAME);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Add the `Saved locally` text block to a tool result. Mutates `msg`. */
export function appendSavedText(msg, { saved, errors }) {
  const result = msg?.result;
  if (!result || typeof result !== "object") {
    return msg;
  }
  const lines = saved.map((item) => `Saved locally: ${item.file} (prompt + metadata: ${item.sidecar})`);
  for (const reason of errors) {
    lines.push(`Could not save image locally: ${reason}`);
  }
  if (lines.length === 0) {
    return msg;
  }
  if (!Array.isArray(result.content)) {
    result.content = [];
  }
  // structuredContent is left untouched: the upstream declares an output
  // schema with additionalProperties: false, so an extra field could fail
  // client-side validation.
  result.content.push({ type: "text", text: lines.join("\n") });
  return msg;
}
