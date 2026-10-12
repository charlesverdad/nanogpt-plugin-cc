import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LineSplitter, CallTracker, processClientLine, summarizeArgs } from "../plugins/nano/scripts/lib/mcp-proxy.mjs";
import { elideDataUrls, slugify } from "../plugins/nano/scripts/lib/media.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROXY = path.join(ROOT, "plugins", "nano", "scripts", "nanogpt-mcp-proxy.mjs");
const FAKE = path.join(ROOT, "tests", "fake-nanogpt-mcp.mjs");
const FAKE_KEY = "fake-key-do-not-leak-1234567890";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function shadowBin() {
  const dir = makeTempDir("nano-shadow-");
  for (const name of ["security", "secret-tool"]) {
    writeExecutable(path.join(dir, name), "#!/bin/sh\nexit 1\n");
  }
  return dir;
}

function startImageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/img.png" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function startProxy(extraEnv = {}, { withKey = true } = {}) {
  const dataDir = makeTempDir("nano-data-");
  const mediaDir = makeTempDir("nano-media-");
  const received = path.join(dataDir, "received.jsonl");
  const env = {
    PATH: `${shadowBin()}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
    HOME: dataDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    NANO_MEDIA_DIR: mediaDir,
    NANO_PROJECT_DIR: "/tmp/some-project",
    NANO_MCP_UPSTREAM: JSON.stringify([process.execPath, FAKE]),
    FAKE_MCP_LOG: received,
    ...extraEnv
  };
  if (withKey) {
    env.NANOGPT_API_KEY = FAKE_KEY;
  }
  const child = spawn(process.execPath, [PROXY], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const waiters = [];
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
    waiters.splice(0).forEach((fn) => fn());
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  let nextId = 1;
  const api = {
    child,
    dataDir,
    mediaDir,
    received,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    async request(method, params) {
      const id = nextId++;
      api.write({ jsonrpc: "2.0", id, method, params });
      for (;;) {
        const hit = lines.find((m) => m.id === id);
        if (hit) {
          return hit;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
    call(name, args) {
      return api.request("tools/call", { name, arguments: args });
    },
    callLog() {
      const file = path.join(dataDir, "mcp-calls.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    receivedMessages() {
      return fs.existsSync(received) ? fs.readFileSync(received, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    },
    async close() {
      child.stdin.end();
      return exited;
    },
    lines
  };
  return api;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function assertNoKey(proxy) {
  assert.ok(!proxy.stdout.includes(FAKE_KEY), "key in stdout");
  assert.ok(!proxy.stderr.includes(FAKE_KEY), "key in stderr");
  for (const dir of [proxy.dataDir, proxy.mediaDir]) {
    for (const file of walk(dir)) {
      if (file !== proxy.received) {
        assert.ok(!fs.readFileSync(file).includes(FAKE_KEY), `key in ${file}`);
      }
    }
  }
}

test("LineSplitter handles partial lines and huge lines", () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push(Buffer.from("ab")), []);
  assert.deepEqual(splitter.push(Buffer.from("c\nde\nf")).map(String), ["abc", "de"]);
  assert.equal(String(splitter.flush()), "f");
  const big = Buffer.alloc(5 * 1024 * 1024, "x");
  assert.equal(new LineSplitter().push(Buffer.concat([big, Buffer.from("\n")]))[0].length, big.length);
});

test("processClientLine injects include_usage only for chat and passes other lines through", () => {
  const tracker = new CallTracker();
  const chat = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nanogpt_chat", arguments: { prompt: "x" } } });
  const out = processClientLine(chat, tracker);
  assert.equal(JSON.parse(out.line).params.arguments.include_usage, true);
  const explicit = JSON.stringify({ id: 2, method: "tools/call", params: { name: "nanogpt_chat", arguments: { include_usage: false } } });
  assert.equal(processClientLine(explicit, tracker).line, explicit);
  const other = Buffer.from("not json tools/call");
  assert.equal(processClientLine(other, tracker).line, other);
  const batch = '[{"method":"tools/call"}]';
  assert.equal(processClientLine(batch, tracker).line, batch);
  const cancelled = processClientLine(JSON.stringify({ method: "notifications/cancelled", params: { requestId: 1 } }), tracker);
  assert.equal(cancelled.cancelled.tool, "nanogpt_chat");
});

test("elideDataUrls and summarizeArgs", () => {
  const url = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.equal(elideDataUrls({ a: [url] }).a[0], `<data-url image/png ${PNG.length} bytes>`);
  assert.match(elideDataUrls(url, () => "x.png"), /saved as x\.png>$/);
  const summary = summarizeArgs({ prompt: "p".repeat(900), messages: [{ role: "user", content: "m".repeat(900) }], n: 2, imageDataUrl: url });
  assert.equal(summary.prompt.length, 500);
  assert.equal(summary.messages[0].content.length, 500);
  assert.equal(summary.n, 2);
  assert.match(summary.imageDataUrl, /^<data-url image\/png/);
  assert.equal(slugify("Hello, World!! A cat"), "hello-world-a-cat");
});

test("missing key exits 1 with the setup command and starts no upstream", async () => {
  const proxy = await startProxy({}, { withKey: false });
  const { code } = await proxy.exited;
  assert.equal(code, 1);
  assert.match(proxy.stderr, /security add-generic-password/);
  assert.equal(proxy.stdout, "");
  assert.equal(fs.existsSync(proxy.received), false);
});

test("handshake, chat usage injection, call log, and key hygiene", async () => {
  const proxy = await startProxy({ NANOGPT_TIMEOUT_MS: "" });
  const init = await proxy.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "fake");
  const list = await proxy.request("tools/list", {});
  assert.equal(list.result.tools.length, 2);

  const chat = await proxy.call("nanogpt_chat", { prompt: "hello", model: "z-ai/glm-5.2" });
  assert.equal(chat.result.structuredContent.include_usage_received, true);
  assert.equal(chat.result.structuredContent.usage.total_tokens, 15);
  const sent = proxy.receivedMessages().find((m) => m.method === "tools/call");
  assert.equal(sent.params.arguments.include_usage, true);

  await proxy.close();
  const [entry] = proxy.callLog();
  assert.equal(entry.tool, "nanogpt_chat");
  assert.equal(entry.ok, true);
  assert.equal(entry.model, "z-ai/glm-5.2");
  assert.equal(entry.usage.total_tokens, 15);
  assert.equal(entry.cost, 0.001);
  assert.equal(entry.promptChars, 5);
  assert.equal(entry.projectDir, "/tmp/some-project");
  assert.equal(typeof entry.ms, "number");
  assert.equal(entry.error, null);
  assertNoKey(proxy);
});

test("image url mode saves file and sidecar, appends text, elides data urls on edit", async () => {
  const { server, url } = await startImageServer();
  const proxy = await startProxy({ FAKE_MCP_IMG_URL: `${url}/redirect` });
  try {
    await proxy.request("initialize", {});
    const prompt = "A red fox in the snow, painted";
    const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
    const res = await proxy.call("nanogpt_image_edit", { prompt, model: "m1", imageDataUrl: dataUrl, size: "1024x1024" });
    const texts = res.result.content.map((c) => c.text);
    const saved = texts.find((t) => t.startsWith("Saved locally: "));
    assert.ok(saved, "appended text");
    const file = saved.match(/^Saved locally: (.+?) \(prompt \+ metadata: (.+)\)$/);
    assert.ok(file);
    assert.deepEqual(fs.readFileSync(file[1]), PNG);
    assert.equal(fs.statSync(file[1]).mode & 0o777, 0o600);
    assert.match(path.basename(file[1]), /^\d{6}-a-red-fox-in-the-snow-painted-[0-9a-f]{6}\.png$/);
    const sidecar = JSON.parse(fs.readFileSync(file[2], "utf8"));
    assert.equal(sidecar.prompt, prompt);
    assert.equal(sidecar.tool, "nanogpt_image_edit");
    assert.equal(sidecar.model, "m1");
    assert.equal(sidecar.bytes, PNG.length);
    assert.equal(sidecar.index, 0);
    assert.equal(sidecar.projectDir, "/tmp/some-project");
    assert.equal(sidecar.source, `${url}/redirect`);
    assert.match(sidecar.sha256, /^[0-9a-f]{64}$/);
    assert.match(sidecar.args.imageDataUrl, /^<data-url image\/png \d+ bytes saved as .*-input-0\.png>$/);
    const inputs = walk(proxy.mediaDir).filter((f) => f.includes("-input-0"));
    assert.equal(inputs.length, 1);
    assert.deepEqual(fs.readFileSync(inputs[0]), PNG);
    assert.equal(res.result.structuredContent.images[0].kind, "url");

    await proxy.close();
    const [entry] = proxy.callLog();
    assert.deepEqual(entry.media, [file[1]]);
    assert.match(entry.args.imageDataUrl, /^<data-url image\/png \d+ bytes>$/);
    assert.equal(entry.promptChars, prompt.length);
    assertNoKey(proxy);
  } finally {
    server.close();
  }
});

test("resource mode reads via a proxy-only resources/read that never reaches the client", async () => {
  const proxy = await startProxy();
  await proxy.request("initialize", {});
  const res = await proxy.call("nanogpt_image_generate", { prompt: "b64 image", response_format: "b64_json" });
  const saved = res.result.content.map((c) => c.text).find((t) => t.startsWith("Saved locally: "));
  const file = saved.match(/^Saved locally: (.+?) \(/)[1];
  assert.deepEqual(fs.readFileSync(file), PNG);
  const reads = proxy.receivedMessages().filter((m) => m.method === "resources/read");
  assert.equal(reads.length, 1);
  assert.match(String(reads[0].id), /^nano-proxy-/);
  assert.ok(!proxy.stdout.includes("nano-proxy-"));
  assert.ok(proxy.lines.every((m) => !String(m.id).startsWith("nano-proxy-")));
  await proxy.close();
});

test("error image and failed download do not fail the call", async () => {
  const proxy = await startProxy({ FAKE_MCP_IMG_URL: "http://127.0.0.1:1/missing.png" });
  await proxy.request("initialize", {});
  const errored = await proxy.call("nanogpt_image_generate", { prompt: "ERROR please" });
  assert.ok(!errored.error);
  assert.match(errored.result.content.at(-1).text, /Could not save image locally: image 0: boom/);
  const failed = await proxy.call("nanogpt_image_generate", { prompt: "unreachable" });
  assert.match(failed.result.content.at(-1).text, /Could not save image locally:/);
  await proxy.close();
  const entries = proxy.callLog();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].media, []);
  assert.match(entries[0].error, /boom/);
  assert.equal(walk(proxy.mediaDir).length, 0);
});

test("cancelled calls are logged and upstream exit propagates its code", async () => {
  const proxy = await startProxy();
  await proxy.request("initialize", {});
  proxy.write({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "nanogpt_chat", arguments: { prompt: "hang" } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  proxy.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [entry] = proxy.callLog();
  assert.equal(entry.cancelled, true);
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "cancelled");
  proxy.write({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "nanogpt_chat", arguments: { prompt: "die" } } });
  const { code } = await proxy.exited;
  assert.equal(code, 3);
  assert.equal(proxy.callLog().at(-1).ok, false);
});

test("closing stdin terminates the upstream and exits", async () => {
  const proxy = await startProxy();
  await proxy.request("initialize", {});
  const result = await proxy.close();
  assert.ok(result.code !== undefined);
});

test("buildChildEnv raises the timeout and sets the key only in the child env", async () => {
  const { buildChildEnv, parseUpstreamCommand, DEFAULT_UPSTREAM } = await import("../plugins/nano/scripts/lib/mcp-proxy.mjs");
  assert.equal(buildChildEnv({}, "k").NANOGPT_TIMEOUT_MS, "300000");
  assert.equal(buildChildEnv({ NANOGPT_TIMEOUT_MS: "999" }, "k").NANOGPT_TIMEOUT_MS, "999");
  assert.equal(buildChildEnv({}, "k").NANOGPT_API_KEY, "k");
  assert.deepEqual(parseUpstreamCommand({}), [...DEFAULT_UPSTREAM]);
  assert.equal(DEFAULT_UPSTREAM.at(-1), "@nanogpt/mcp@1.5.0");
  assert.throws(() => parseUpstreamCommand({ NANO_MCP_UPSTREAM: "nope" }));
});

test(".mcp.json starts the proxy directly, so the script must stay executable", () => {
  // The command names the script itself (no `node` + args): AgentShield flags
  // `${...}` in MCP args as shell metacharacters. Claude Code spawns it without
  // a shell, so it needs the exec bit and a node shebang.
  const pluginRoot = path.join(ROOT, "plugins", "nano");
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const server = config.mcpServers.nanogpt;
  assert.equal(server.command, "${CLAUDE_PLUGIN_ROOT}/scripts/nanogpt-mcp-proxy.mjs");
  assert.equal(server.args, undefined);
  const script = server.command.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  assert.equal(script, PROXY);
  assert.ok(fs.statSync(script).mode & 0o111, "proxy script must be executable");
  assert.match(fs.readFileSync(script, "utf8").split("\n", 1)[0], /^#!\/usr\/bin\/env node$/);
});
