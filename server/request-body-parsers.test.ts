import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerRequestBodyParsers } from "./request-body-parsers";

/*
 * The production /mcp route (server/rent-ops/mcp/routes.ts) hands req.body to
 * a stateless Streamable HTTP transport. This mounts the same transport
 * behind the same parser registration used by server/index.ts and posts a
 * base64 upload far above Express's 100 KB default.
 */
function app() {
  const server = express();
  registerRequestBodyParsers(server);
  server.post("/mcp", async (req, res) => {
    const mcp = new McpServer({ name: "body-limit-test", version: "1" });
    mcp.registerTool("stage_bytes", { description: "Report the decoded size of base64 content.", inputSchema: { contentBase64: z.string() } }, async ({ contentBase64 }) => {
      const bytes = Buffer.from(contentBase64, "base64").length;
      return { content: [{ type: "text", text: String(bytes) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  server.post("/api/echo", (req, res) => { res.json({ keys: Object.keys(req.body ?? {}).length }); });
  return server;
}

test("a multi-megabyte base64 MCP upload passes the JSON parser while other routes keep the default limit", async () => {
  const listener = app().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stage_bytes", arguments: { contentBase64: bytes.toString("base64") } } };
    const body = JSON.stringify(rpc);
    assert.ok(body.length > 4 * 1024 * 1024, "well above the 100 KB default");
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const parsed = JSON.parse(text) as { result?: { content?: { text: string }[] } };
    assert.equal(parsed.result?.content?.[0]?.text, String(bytes.length), "the tool received the whole upload");

    const large = JSON.stringify({ padding: "x".repeat(200 * 1024) });
    const other = await fetch(`${base}/api/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: large });
    assert.equal(other.status, 413, "non-MCP routes keep Express's default JSON limit");
    const small = await fetch(`${base}/api/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await small.json(), { keys: 1 });

    const oversized = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ ...rpc, params: { ...rpc.params, arguments: { contentBase64: "A".repeat(17 * 1024 * 1024) } } }) });
    assert.equal(oversized.status, 413, "MCP bodies are still bounded");
  } finally {
    listener.close();
  }
});
