// Shared streamable-HTTP (stateless) plumbing for the PiRPC MCP servers.
//
// One fresh transport + server instance per request: no session state in
// memory. The tools are stateless, so nothing is lost between requests.
// enableJsonResponse returns plain JSON instead of opening an SSE stream per
// call, which is all a tools-only server needs.

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Returns an async (req, res, parsedBody) => void request handler.
export function createStatelessHandler(buildServer) {
  return async (req, res, parsedBody) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session id, no validation
      enableJsonResponse: true,
    });
    const server = buildServer();
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  };
}

// Serve a stateless handler on its own port (standalone dev mode).
// POST with a JSON body is the only supported method; GET/DELETE get 405.
export function serveHttp(handler, port) {
  const httpServer = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      await handler(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      if (!res.headersSent) res.writeHead(400).end("invalid JSON body");
    }
  });
  return httpServer.listen(port);
}
