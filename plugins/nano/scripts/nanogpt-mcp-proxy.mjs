#!/usr/bin/env node
/**
 * Logging proxy MCP server wrapping @nanogpt/mcp. Speaks newline-delimited
 * JSON-RPC on stdio to Claude Code and to the upstream child. It logs every
 * tool call, archives generated images with their prompts, takes the API key
 * from the keychain, and raises the upstream timeout.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { IMAGE_TOOLS, saveImages } from "./lib/media.mjs";
import {
  CallTracker,
  LineSplitter,
  PROXY_ID_PREFIX,
  SAVE_WAIT_MS,
  appendCallLog,
  appendSavedText,
  buildChildEnv,
  buildLogEntry,
  classifyUpstreamLine,
  parseUpstreamCommand,
  processClientLine
} from "./lib/mcp-proxy.mjs";
import { KEY_SETUP_COMMAND, resolveApiKey } from "./lib/runtime.mjs";

const RESOURCE_TIMEOUT_MS = 30_000;

function fail(message) {
  process.stderr.write(`nano mcp proxy: ${message}\n`);
  process.exit(1);
}

let upstreamCommand;
try {
  upstreamCommand = parseUpstreamCommand(process.env);
} catch (error) {
  fail(error.message);
}

const { key } = resolveApiKey();
if (!key) {
  fail(`No NanoGPT API key found. Store it in the macOS keychain with: ${KEY_SETUP_COMMAND}`);
}

const [command, ...commandArgs] = upstreamCommand;
const child = spawn(command, commandArgs, {
  env: buildChildEnv(process.env, key),
  stdio: ["pipe", "pipe", "inherit"],
  shell: false
});
child.on("error", (error) => fail(`could not start upstream (${command}): ${error.code ?? error.message}`));
child.stdin.on("error", () => {});

const tracker = new CallTracker();
const proxyPending = new Map();
const background = new Set();
let proxyCounter = 0;

function sendUpstream(line) {
  child.stdin.write(line);
  child.stdin.write("\n");
}

function sendClient(line) {
  process.stdout.write(line);
  process.stdout.write("\n");
}

/** Ask the upstream to read a resource and return its base64 blob. */
function readResource(uri) {
  const id = `${PROXY_ID_PREFIX}${++proxyCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proxyPending.delete(id);
      reject(new Error("timed out reading the image resource"));
    }, RESOURCE_TIMEOUT_MS);
    proxyPending.set(id, (msg) => {
      clearTimeout(timer);
      const blob = msg.result?.contents?.[0]?.blob;
      if (typeof blob === "string") {
        resolve(blob);
      } else {
        reject(new Error(msg.error?.message ?? "resource had no data"));
      }
    });
    sendUpstream(JSON.stringify({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } }));
  });
}

async function handleResponse(msg, call, receivedAt) {
  const env = process.env;
  const isImageTool = IMAGE_TOOLS.includes(call.tool);
  const structured = msg.result?.structuredContent;
  if (!isImageTool || msg.error || msg.result?.isError || !Array.isArray(structured?.images)) {
    appendCallLog(buildLogEntry({ call, msg, now: receivedAt, env }), env);
    sendClient(JSON.stringify(msg));
    return;
  }

  const task = saveImages({ tool: call.tool, args: call.args, structured, env, readResource }).catch((error) => ({
    saved: [],
    errors: [String(error?.message ?? error)]
  }));
  const finish = (outcome) =>
    appendCallLog(
      buildLogEntry({
        call,
        msg,
        now: receivedAt,
        env,
        media: outcome.saved.flatMap((item) => [item.file]),
        extraError: outcome.errors.length ? outcome.errors.join("; ") : null
      }),
      env
    );

  let timer;
  const timedOut = Symbol("timeout");
  const first = await Promise.race([
    task,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timedOut), SAVE_WAIT_MS);
    })
  ]);
  clearTimeout(timer);

  if (first === timedOut) {
    sendClient(JSON.stringify(msg));
    const tail = task.then(finish);
    background.add(tail);
    tail.finally(() => background.delete(tail));
    return;
  }
  finish(first);
  sendClient(JSON.stringify(appendSavedText(msg, first)));
}

// Upstream -> client.
const upstreamLines = new LineSplitter();
const settled = new Set();

function onUpstreamLine(line) {
  const classified = classifyUpstreamLine(line, tracker);
  if (classified.kind === "proxy") {
    const handler = proxyPending.get(classified.msg.id);
    proxyPending.delete(classified.msg.id);
    handler?.(classified.msg);
    return;
  }
  if (classified.kind === "response") {
    const work = handleResponse(classified.msg, classified.call, Date.now()).catch(() => {
      sendClient(JSON.stringify(classified.msg));
    });
    settled.add(work);
    work.finally(() => settled.delete(work));
    return;
  }
  sendClient(line);
}

child.stdout.on("data", (chunk) => {
  for (const line of upstreamLines.push(chunk)) {
    onUpstreamLine(line);
  }
});

// Client -> upstream.
const clientLines = new LineSplitter();

function onClientLine(line) {
  const { line: out, cancelled } = processClientLine(line, tracker, Date.now());
  if (cancelled) {
    appendCallLog(buildLogEntry({ call: cancelled, msg: null, now: Date.now(), env: process.env, cancelled: true }), process.env);
  }
  sendUpstream(out);
}

process.stdin.on("data", (chunk) => {
  for (const line of clientLines.push(chunk)) {
    onClientLine(line);
  }
});
process.stdin.on("end", () => {
  const rest = clientLines.flush();
  if (rest) {
    onClientLine(rest);
  }
  child.stdin.end();
  child.kill("SIGTERM");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("close", async (code) => {
  for (const call of tracker.remaining()) {
    const entry = buildLogEntry({ call, msg: { error: { message: "upstream exited before responding" } }, env: process.env });
    appendCallLog(entry, process.env);
  }
  await Promise.race([
    Promise.allSettled([...settled, ...background]),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  process.exit(code ?? 1);
});
