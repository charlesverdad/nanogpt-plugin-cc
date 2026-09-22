// A scripted stand-in for an Anthropic-compatible Messages endpoint, used to
// drive the REAL `claude` binary offline (tests/real-claude-boundary.test.mjs).
//
// Every main-loop request (one that offers tools) gets the next scripted
// tool call; once the script is exhausted it answers with plain text "DONE".
// Requests without tools (side queries) also get "DONE". Streaming (SSE) and
// non-streaming requests are both supported. It is launched as a separate
// process and prints `LISTENING <port>` once ready.
//
// Env:
//   FAKE_ANTHROPIC_STEPS  JSON array of { name, input } tool calls, in order.
//   FAKE_ANTHROPIC_LOG    file that receives one JSON line per request with
//                         the tool_result blocks it carried.

import fs from "node:fs";
import { createServer } from "node:http";

const STEPS = JSON.parse(process.env.FAKE_ANTHROPIC_STEPS ?? "[]");
const LOG_FILE = process.env.FAKE_ANTHROPIC_LOG ?? null;

let counter = 0;

function log(entry) {
  if (LOG_FILE) {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function toolResultText(block) {
  if (typeof block.content === "string") {
    return block.content;
  }
  if (Array.isArray(block.content)) {
    return block.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function nextBlock(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const step = messages.filter((message) => message.role === "assistant").length;
  if (tools.length > 0 && step < STEPS.length) {
    return { type: "tool_use", id: `toolu_step_${step}`, name: STEPS[step].name, input: STEPS[step].input };
  }
  return { type: "text", text: "DONE" };
}

function writeSse(res, model, block) {
  counter += 1;
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${counter}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    }
  ];
  if (block.type === "text") {
    events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } });
  } else {
    events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    events.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  }
  events.push({ type: "content_block_stop", index: 0 });
  events.push({
    type: "message_delta",
    delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 }
  });
  events.push({ type: "message_stop" });

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const raw = await readBody(req);
  const url = req.url ?? "";

  if (url.includes("count_tokens")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (req.method !== "POST" || !url.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = {};
  }

  const toolResults = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block && block.type === "tool_result") {
        toolResults.push({ toolUseId: block.tool_use_id, isError: block.is_error === true, text: toolResultText(block) });
      }
    }
  }
  log({ model: body.model ?? null, tools: (body.tools ?? []).map((tool) => tool.name), toolResults });

  const block = nextBlock(body);
  const model = body.model ?? "fake-model";
  if (body.stream) {
    writeSse(res, model, block);
    return;
  }
  counter += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_${counter}`,
      type: "message",
      role: "assistant",
      model,
      content: [block],
      stop_reason: block.type === "text" ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 }
    })
  );
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
