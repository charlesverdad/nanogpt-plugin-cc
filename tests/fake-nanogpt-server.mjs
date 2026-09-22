// A tiny HTTP server that stands in for NanoGPT's API surface during setup
// tests. It is launched as a SEPARATE child process because the companion is
// invoked with spawnSync (which blocks the event loop), so an in-process
// server would deadlock.
//
// Routes:
//   POST /v1/messages            -> 200 message payload (401 on wrong api key)
//   GET  /subscription/v1/usage  -> active subscription usage (or inactive)
//   GET  /v1/models?detailed=true-> a small authenticated catalog
//
// Env:
//   FAKE_NANOGPT_EXPECTED_KEY  the api key the server expects in x-api-key
//   FAKE_NANOGPT_MODE          "inactive" makes /subscription return active:false

import { createServer } from "node:http";

const EXPECTED_KEY = process.env.FAKE_NANOGPT_EXPECTED_KEY ?? "nano-test-key-DO-NOT-LEAK-7f3a";
const MODE = process.env.FAKE_NANOGPT_MODE ?? "active";

const CATALOG = {
  object: "list",
  data: [
    {
      id: "z-ai/glm-5.2",
      context_length: 1048576,
      capabilities: { tool_calling: true },
      subscription: { included: true, inputTokenMultiplier: 1 }
    },
    {
      id: "z-ai/glm-5.2:thinking",
      context_length: 1048576,
      capabilities: { tool_calling: true },
      subscription: { included: true, inputTokenMultiplier: 1 }
    },
    {
      id: "z-ai/glm-5.3",
      context_length: 1048576,
      capabilities: { tool_calling: true },
      subscription: { included: true, inputTokenMultiplier: 2 }
    },
    {
      id: "z-ai/glm-5.3-flash",
      context_length: 1048576,
      capabilities: { tool_calling: true },
      subscription: { included: true, inputTokenMultiplier: 1 }
    },
    {
      id: "minimax/minimax-m3",
      context_length: 512000,
      capabilities: { tool_calling: true },
      subscription: { included: true, inputTokenMultiplier: 1 }
    },
    {
      id: "anthropic/claude-sonnet-5",
      context_length: 200000,
      capabilities: { tool_calling: true },
      subscription: { included: false, inputTokenMultiplier: 1 }
    }
  ]
};

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname + url.search;

  // All authenticated routes require the right api key.
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== EXPECTED_KEY) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && path === "/v1/messages") {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
    sendJson(res, 200, {
      type: "message",
      model: body.model ?? "z-ai/glm-5.2",
      content: [{ type: "text", text: "OK." }],
      usage: { input_tokens: 7, output_tokens: 2, cost: 0.00001 }
    });
    return;
  }

  if (req.method === "GET" && path === "/subscription/v1/usage") {
    if (MODE === "inactive") {
      sendJson(res, 200, {
        active: false,
        allowOverage: false,
        limits: { weeklyInputTokens: 60000000 },
        weeklyInputTokens: { used: 60000000, remaining: 0, resetAt: 1790553600000 }
      });
      return;
    }
    sendJson(res, 200, {
      active: true,
      allowOverage: false,
      limits: { weeklyInputTokens: 60000000 },
      weeklyInputTokens: { used: 1000, remaining: 59999000, resetAt: 1790553600000 }
    });
    return;
  }

  if (req.method === "GET" && path === "/v1/models?detailed=true") {
    sendJson(res, 200, CATALOG);
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`LISTENING ${port}\n`);
});
