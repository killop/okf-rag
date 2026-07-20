#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { sanitizeDiagnosticText } = require("./diagnostics.js");
const { loadProjectLlmwikiEnv } = require("./llmwiki_env.js");

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    readyFile: "",
    probe: false,
    timeoutMs: 120_000,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") args.host = requireValue(argv, ++i, arg);
    else if (arg === "--port") args.port = positiveOrZero(requireValue(argv, ++i, arg), arg);
    else if (arg === "--ready-file") args.readyFile = requireValue(argv, ++i, arg);
    else if (arg === "--timeout-ms") args.timeoutMs = positive(requireValue(argv, ++i, arg), arg);
    else if (arg === "--probe") args.probe = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positive(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function positiveOrZero(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`);
  return parsed;
}

function printHelp() {
  console.log(`openai_stream_adapter

Converts non-streaming OpenAI chat/completions requests into upstream
stream:true requests, then aggregates SSE into a standard JSON response.

Required environment:
  OPENAI_BASE_URL       Upstream OpenAI-compatible base URL, normally ending /v1.
  OPENAI_API_KEY        Upstream key. It is never printed.
  LLMWIKI_MODEL         Model name used by --probe.

Project-local fallback:
  .okf-rag/llmwiki.env  Loaded from the current project root. Explicit process
                        environment variables override the file.

Usage:
  node scripts/openai_stream_adapter.js --probe
  node scripts/openai_stream_adapter.js --port 17890
`);
}

function configFromEnv() {
  const baseURL = (
    process.env.OPENAI_STREAM_UPSTREAM_BASE_URL || process.env.OPENAI_BASE_URL || ""
  ).trim();
  if (!baseURL) throw new Error("OPENAI_BASE_URL is required");
  const parsed = new URL(baseURL);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL must use http or https");
  }
  return {
    baseURL: parsed.toString().replace(/\/$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.LLMWIKI_MODEL || "",
  };
}

function upstreamUrl(baseURL, incomingPath) {
  const base = new URL(baseURL);
  const incoming = new URL(incomingPath, "http://adapter.local");
  const basePath = base.pathname.replace(/\/$/, "");
  let suffix = incoming.pathname;
  if (basePath.endsWith("/v1") && suffix.startsWith("/v1/")) {
    suffix = suffix.slice(3);
  } else if (basePath && suffix.startsWith(`${basePath}/`)) {
    suffix = suffix.slice(basePath.length);
  }
  base.pathname = `${basePath}/${suffix.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  base.search = incoming.search;
  return base;
}

function requestHeaders(inputHeaders, config, contentLength) {
  const headers = {};
  for (const [name, value] of Object.entries(inputHeaders || {})) {
    const lower = name.toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) continue;
    if (value !== undefined) headers[name] = value;
  }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return headers;
}

async function upstreamFetch(config, requestPath, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(upstreamUrl(config.baseURL, requestPath), {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function collectSse(response) {
  if (!response.body) throw new Error("upstream returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawPreview = "";
  const events = [];

  const consumeLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.error) {
        throw new Error(parsed.error.message || JSON.stringify(parsed.error));
      }
      events.push(parsed);
    } catch (error) {
      throw new Error(`invalid or failed SSE event from upstream: ${error.message}`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (rawPreview.length < 500) rawPreview += text.slice(0, 500 - rawPreview.length);
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (events.length === 0) {
    throw new Error(`upstream returned no SSE data events: ${rawPreview.trim().slice(0, 500)}`);
  }
  return events;
}

function aggregateChatCompletion(events) {
  const choices = new Map();
  let envelope = null;
  let usage;

  for (const event of events) {
    envelope ||= event;
    if (event.usage) usage = event.usage;
    for (const choice of event.choices || []) {
      const index = choice.index ?? 0;
      if (!choices.has(index)) {
        choices.set(index, {
          index,
          message: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
          toolCalls: new Map(),
        });
      }
      const target = choices.get(index);
      const delta = choice.delta || choice.message || {};
      if (delta.role) target.message.role = delta.role;
      if (typeof delta.content === "string") target.message.content += delta.content;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        target.finish_reason = choice.finish_reason;
      }
      for (const toolCall of delta.tool_calls || []) {
        const toolIndex = toolCall.index ?? target.toolCalls.size;
        if (!target.toolCalls.has(toolIndex)) {
          target.toolCalls.set(toolIndex, {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const toolTarget = target.toolCalls.get(toolIndex);
        if (toolCall.id) toolTarget.id = toolCall.id;
        if (toolCall.type) toolTarget.type = toolCall.type;
        if (toolCall.function?.name) toolTarget.function.name += toolCall.function.name;
        if (toolCall.function?.arguments) {
          toolTarget.function.arguments += toolCall.function.arguments;
        }
      }
    }
  }

  const aggregatedChoices = [...choices.values()]
    .sort((a, b) => a.index - b.index)
    .map((choice) => {
      const toolCalls = [...choice.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
      delete choice.toolCalls;
      if (toolCalls.length > 0) choice.message.tool_calls = toolCalls;
      if (!choice.message.content) choice.message.content = null;
      return choice;
    });

  return {
    id: envelope?.id || `chatcmpl-adapter-${Date.now()}`,
    object: "chat.completion",
    created: envelope?.created || Math.floor(Date.now() / 1000),
    model: envelope?.model || "unknown",
    choices: aggregatedChoices,
    ...(usage ? { usage } : {}),
    ...(envelope?.system_fingerprint
      ? { system_fingerprint: envelope.system_fingerprint }
      : {}),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function copyResponseHeaders(response, target) {
  for (const [name, value] of response.headers.entries()) {
    if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) {
      continue;
    }
    target.setHeader(name, value);
  }
}

async function pipeWebBody(body, response) {
  if (!body) return response.end();
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function proxyRequest(request, response, config, timeoutMs) {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: true }));
  }

  const bodyBuffer = await readRequestBody(request);
  const isChat = new URL(request.url, "http://adapter.local").pathname.endsWith(
    "/chat/completions"
  );
  let requestBody = bodyBuffer;
  let requestedStream = false;
  if (isChat && bodyBuffer.length > 0) {
    const parsed = JSON.parse(bodyBuffer.toString("utf8"));
    requestedStream = parsed.stream === true;
    parsed.stream = true;
    requestBody = Buffer.from(JSON.stringify(parsed), "utf8");
  }

  const upstream = await upstreamFetch(
    config,
    request.url,
    {
      method: request.method,
      headers: requestHeaders(request.headers, config, requestBody.length),
      body: ["GET", "HEAD"].includes(request.method) ? undefined : requestBody,
    },
    timeoutMs
  );

  if (!isChat || requestedStream || !upstream.ok) {
    response.statusCode = upstream.status;
    copyResponseHeaders(upstream, response);
    return pipeWebBody(upstream.body, response);
  }

  const events = await collectSse(upstream);
  const aggregated = aggregateChatCompletion(events);
  const output = Buffer.from(JSON.stringify(aggregated), "utf8");
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": output.length,
  });
  response.end(output);
}

async function streamedChat(config, body, timeoutMs) {
  const payload = Buffer.from(JSON.stringify({ ...body, stream: true }), "utf8");
  const response = await upstreamFetch(
    config,
    "/v1/chat/completions",
    {
      method: "POST",
      headers: requestHeaders({ "content-type": "application/json" }, config, payload.length),
      body: payload,
    },
    timeoutMs
  );
  if (!response.ok) {
    throw new Error(`upstream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const events = await collectSse(response);
  return { events, aggregated: aggregateChatCompletion(events) };
}

async function runProbe(config, timeoutMs) {
  if (!config.model) throw new Error("LLMWIKI_MODEL is required for --probe");
  const textProbe = await streamedChat(
    config,
    {
      model: config.model,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
    },
    timeoutMs
  );
  const text = textProbe.aggregated.choices[0]?.message?.content || "";
  if (!text) throw new Error("text stream returned no content");

  const toolProbe = await streamedChat(
    config,
    {
      model: config.model,
      max_tokens: 128,
      messages: [{ role: "user", content: "Call emit_probe with ok=true." }],
      tools: [
        {
          type: "function",
          function: {
            name: "emit_probe",
            description: "Return the stream compatibility probe result.",
            parameters: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "required",
    },
    timeoutMs
  );
  const toolCall = toolProbe.aggregated.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error("streaming tool call was not returned; llmwiki concept extraction will not work");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseURL: new URL(config.baseURL).origin,
        model: config.model,
        textStream: { chunks: textProbe.events.length, content: text.slice(0, 80) },
        toolStream: {
          chunks: toolProbe.events.length,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      },
      null,
      2
    )
  );
}

async function startServer(args, config) {
  const server = http.createServer((request, response) => {
    proxyRequest(request, response, config, args.timeoutMs).catch((error) => {
      if (response.headersSent) return response.destroy(error);
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: sanitizeDiagnosticText(error.message),
            type: "stream_adapter_error",
          },
        })
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  if (args.readyFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.readyFile)), { recursive: true });
    fs.writeFileSync(
      path.resolve(args.readyFile),
      JSON.stringify({ pid: process.pid, host: args.host, port }, null, 2) + "\n",
      "utf8"
    );
  }
  console.log(`OpenAI stream adapter listening on http://${args.host}:${port}/v1`);
  console.log(`upstream: ${new URL(config.baseURL).origin}`);
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  loadProjectLlmwikiEnv(process.cwd());
  const config = configFromEnv();
  if (args.probe) return runProbe(config, args.timeoutMs);
  return startServer(args, config);
}

module.exports = { aggregateChatCompletion, upstreamUrl };

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `Error: ${sanitizeDiagnosticText(error instanceof Error ? error.message : error)}`
    );
    process.exit(1);
  });
}
