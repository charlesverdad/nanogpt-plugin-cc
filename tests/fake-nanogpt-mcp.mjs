// Scripted stand-in for @nanogpt/mcp, run through NANO_MCP_UPSTREAM.
// Logs every received message to FAKE_MCP_LOG; image URL mode points at FAKE_MCP_IMG_URL.
import fs from "node:fs";
import readline from "node:readline";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const resources = new Map();
const log = process.env.FAKE_MCP_LOG;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (log) {
    fs.appendFileSync(log, line + "\n");
  }
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake", version: "0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "nanogpt_chat" }, { name: "nanogpt_image_generate" }] } });
  } else if (method === "resources/read") {
    const blob = resources.get(params.uri);
    send(blob ? { jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, mimeType: "image/png", blob }] } } : { jsonrpc: "2.0", id, error: { code: -32002, message: "not found" } });
  } else if (method === "tools/call") {
    const args = params.arguments ?? {};
    if (params.name === "nanogpt_chat") {
      if (args.prompt === "hang") {
        return;
      }
      if (args.prompt === "die") {
        process.exit(3);
      }
      const structuredContent = { text: "hi", include_usage_received: args.include_usage === true };
      if (args.include_usage) {
        structuredContent.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "hi" }], structuredContent } });
    } else if (params.name === "nanogpt_image_generate" || params.name === "nanogpt_image_edit") {
      const images = [];
      if (String(args.prompt).includes("ERROR")) {
        images.push({ kind: "error", error: "boom" });
      } else if (args.response_format === "b64_json") {
        const uri = `nanogpt://image/${resources.size + 1}`;
        resources.set(uri, PNG.toString("base64"));
        images.push({ kind: "resource", uri, mimeType: "image/png", bytes: PNG.length });
      } else {
        images.push({ kind: "url", url: process.env.FAKE_MCP_IMG_URL });
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }], structuredContent: { images } } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown tool" } });
    }
  }
});
