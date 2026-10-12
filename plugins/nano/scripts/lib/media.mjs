/**
 * Local archive for images generated through the NanoGPT MCP tools: image
 * files plus a JSON sidecar holding the original prompt and call arguments.
 * Nothing here ever sees the API key.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir, resolveFallbackDataDir } from "./state.mjs";

export const IMAGE_TOOLS = Object.freeze(["nanogpt_image_generate", "nanogpt_image_edit"]);
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,/i;

export function isUsableEnvValue(value) {
  const text = String(value ?? "").trim();
  return text !== "" && !text.includes("${");
}

export function resolveDataDir(env = process.env) {
  return isUsableEnvValue(env.CLAUDE_PLUGIN_DATA) ? String(env.CLAUDE_PLUGIN_DATA).trim() : resolveFallbackDataDir();
}

export function resolveMediaDir(env = process.env) {
  if (isUsableEnvValue(env.NANO_MEDIA_DIR)) {
    return String(env.NANO_MEDIA_DIR).trim();
  }
  return path.join(resolveDataDir(env), "media");
}

export function resolveProjectDir(env = process.env) {
  return isUsableEnvValue(env.NANO_PROJECT_DIR) ? String(env.NANO_PROJECT_DIR).trim() : null;
}

/** Create a directory tree with mode 0700; the fallback root is checked for ownership. */
export function ensureDir(dir, env = process.env) {
  const fallback = resolveFallbackDataDir();
  if (!isUsableEnvValue(env.CLAUDE_PLUGIN_DATA) && (dir === fallback || dir.startsWith(fallback + path.sep))) {
    ensurePrivateDir(fallback);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function slugify(prompt) {
  const slug = String(prompt ?? "")
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "image";
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export function localDateParts(date) {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  };
}

const MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Extension from content-type, then magic bytes, then `.png`. */
export function pickExtension(contentType, buffer) {
  const mime = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (MIME_EXT[mime]) {
    return { ext: MIME_EXT[mime], mimeType: mime === "image/jpg" ? "image/jpeg" : mime };
  }
  const sniffed = sniffImageType(buffer);
  if (sniffed) {
    return { ext: MIME_EXT[sniffed], mimeType: sniffed };
  }
  return { ext: ".png", mimeType: mime.startsWith("image/") ? mime : "image/png" };
}

export function parseDataUrl(text) {
  const match = DATA_URL_RE.exec(text);
  if (!match) {
    return null;
  }
  const mimeType = match[1] || "text/plain";
  const body = text.slice(match[0].length);
  try {
    const data = match[3] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "latin1");
    return { mimeType, data };
  } catch {
    // Malformed percent-encoding.
    return null;
  }
}

/**
 * Replace every data URL string inside `value` (deeply) with a short marker.
 * `fileFor(dataUrl)` may return a file name to mention in the marker.
 */
export function elideDataUrls(value, fileFor = () => null) {
  if (typeof value === "string") {
    if (!/^data:/i.test(value)) {
      return value;
    }
    const parsed = parseDataUrl(value);
    if (!parsed) {
      return `<data-url ${value.length} chars>`;
    }
    const file = fileFor(value);
    return `<data-url ${parsed.mimeType} ${parsed.data.length} bytes${file ? ` saved as ${file}` : ""}>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => elideDataUrls(item, fileFor));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, elideDataUrls(item, fileFor)]));
  }
  return value;
}

/** Input images of an edit call, in order: imageDataUrl then imageDataUrls. */
export function collectInputDataUrls(args) {
  const urls = [];
  if (typeof args?.imageDataUrl === "string" && /^data:/i.test(args.imageDataUrl)) {
    urls.push(args.imageDataUrl);
  }
  if (Array.isArray(args?.imageDataUrls)) {
    for (const item of args.imageDataUrls) {
      if (typeof item === "string" && /^data:/i.test(item)) {
        urls.push(item);
      }
    }
  }
  return [...new Set(urls)];
}

async function readBodyCapped(response, cap) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`image is larger than ${cap} bytes`);
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`image is larger than ${cap} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Fetch an http(s) image with a timeout and a size cap, following redirects manually. */
export async function fetchImage(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const cap = options.maxBytes ?? MAX_IMAGE_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error("invalid image URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`unsupported URL scheme ${parsed.protocol}`);
    }
    const response = await fetchImpl(parsed.href, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location"), parsed).href;
      await response.body?.cancel?.().catch(() => {});
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    const data = await readBodyCapped(response, cap);
    return { data, contentType: response.headers.get("content-type") };
  }
  throw new Error("too many redirects");
}

function writePrivateFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

/**
 * Save every image of an image-tool result, plus a sidecar each.
 *
 * @returns {Promise<{ saved: Array<{file:string, sidecar:string}>, errors: string[] }>}
 */
export async function saveImages({ tool, args, structured, env = process.env, readResource, fetchImpl, now = new Date() }) {
  const images = Array.isArray(structured?.images) ? structured.images : [];
  const saved = [];
  const errors = [];
  if (images.length === 0) {
    return { saved, errors };
  }

  const mediaDir = resolveMediaDir(env);
  const { day, time } = localDateParts(now);
  const dayDir = ensureDir(path.join(mediaDir, day), env);
  const callBase = `${time}-${slugify(args?.prompt)}-${randomBytes(3).toString("hex")}`;
  const multi = images.length > 1;

  // Input images of an edit call.
  const inputFiles = new Map();
  if (tool === "nanogpt_image_edit") {
    collectInputDataUrls(args).forEach((dataUrl, i) => {
      try {
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) {
          return;
        }
        const { ext } = pickExtension(parsed.mimeType, parsed.data);
        const name = `${callBase}-input-${i}${ext}`;
        writePrivateFile(path.join(dayDir, name), parsed.data);
        inputFiles.set(dataUrl, name);
      } catch (error) {
        errors.push(`input image ${i}: ${error.message}`);
      }
    });
  }
  const sidecarArgs = elideDataUrls(args ?? {}, (dataUrl) => inputFiles.get(dataUrl) ?? null);

  for (let i = 0; i < images.length; i += 1) {
    const item = images[i];
    try {
      if (item?.kind === "error") {
        throw new Error(String(item.error ?? "image generation failed"));
      }
      let data;
      let contentType = null;
      let source;
      if (item?.kind === "url") {
        source = String(item.url);
        ({ data, contentType } = await fetchImage(source, { fetchImpl }));
      } else if (item?.kind === "resource") {
        source = String(item.uri);
        contentType = item.mimeType ?? null;
        if (typeof readResource !== "function") {
          throw new Error("resource reading is unavailable");
        }
        const blob = await readResource(source);
        data = Buffer.from(blob, "base64");
      } else {
        throw new Error("unrecognised image entry");
      }
      const { ext, mimeType } = pickExtension(contentType, data);
      const base = multi ? `${callBase}-${i}` : callBase;
      const file = path.join(dayDir, `${base}${ext}`);
      const sidecar = path.join(dayDir, `${base}.json`);
      writePrivateFile(file, data);
      writePrivateFile(
        sidecar,
        JSON.stringify(
          {
            ts: now.toISOString(),
            tool,
            model: args?.model ?? null,
            prompt: args?.prompt ?? null,
            args: sidecarArgs,
            source,
            mimeType,
            bytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
            projectDir: resolveProjectDir(env),
            index: i,
            inputs: [...inputFiles.values()].map((name) => path.join(dayDir, name))
          },
          null,
          2
        ) + "\n"
      );
      saved.push({ file, sidecar });
    } catch (error) {
      errors.push(`image ${i}: ${error?.message ?? error}`);
    }
  }
  return { saved, errors };
}
