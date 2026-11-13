// Bridge: browser <-> Pi RPC.
//
// Pi's RPC mode speaks JSONL over stdin/stdout. A browser cannot talk to a
// subprocess, so this server does all of:
//   1. serves the static frontends from ./public
//   2. accepts WebSocket clients on /ws and spawns ONE `pi --mode rpc` child
//      per connection, giving every frontend its own independent session
//   3. accepts Word uploads on POST /upload?name=<file.docx> into uploads/
//   4. serves converted PDFs from output/ at /output/<file>.pdf
//   5. logs every chat message with its timestamp to logs/<session>.jsonl
//
// --approve lets each child trust this project's .pi/mcp.json (time,
// docx2pdf, and delegate servers) without touching the user-level config.
// The parent cannot call docx2pdf directly; its prompt routes Word conversion
// through the delegate so conversion details stay out of this conversation.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const LOG_DIR = new URL("./logs/", import.meta.url).pathname;
const UPLOADS_DIR = resolve(new URL("./uploads/", import.meta.url).pathname);
const OUTPUT_DIR = resolve(new URL("./output/", import.meta.url).pathname);
const DELEGATE_PROMPT = "When the user asks to convert a Word document to PDF, use the delegate_docx2pdf_conversion tool. This delegates the conversion to a specialized sub-agent, keeping this conversation's context clean.";
const PI_ARGS = [
  "--mode", "rpc",
  "--no-session",
  "--approve",
  "--exclude-tools", "mcp__docx2pdf__*",
  "--append-system-prompt", DELEGATE_PROMPT,
];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

for (const dir of [LOG_DIR, UPLOADS_DIR, OUTPUT_DIR]) await mkdir(dir, { recursive: true });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

// POST /upload?name=contract.docx — raw body saved into uploads/ only.
async function handleUpload(req, res) {
  const url = new URL(req.url, "http://localhost");
  const name = basename(decodeURIComponent(url.searchParams.get("name") ?? ""));
  if (!name || !/\.(docx|doc)$/i.test(name)) {
    sendJson(res, 400, { ok: false, error: "query param 'name' must be a .docx or .doc file name" });
    return;
  }
  const size = Number(req.headers["content-length"] ?? 0);
  if (size > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { ok: false, error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` });
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { ok: false, error: "file too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const target = join(UPLOADS_DIR, name);
  await writeFile(target, Buffer.concat(chunks));
  console.log(`[bridge] upload: ${name} (${received} bytes)`);
  sendJson(res, 200, { ok: true, name, path: `uploads/${name}` });
}

// GET /output/<file> — converted PDFs, confined to output/.
async function handleOutput(req, res, urlPath) {
  const filePath = resolve(OUTPUT_DIR, decodeURIComponent(urlPath.slice("/output/".length)));
  if (filePath !== OUTPUT_DIR && !filePath.startsWith(OUTPUT_DIR + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && urlPath === "/upload") return handleUpload(req, res);
  if (req.method !== "GET") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  if (urlPath.startsWith("/output/")) return handleOutput(req, res, urlPath);

  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC_DIR, relPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const client = req.socket.remoteAddress;
  // Timestamped name sorts chronologically; the random suffix avoids collisions.
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`);
  const log = (direction, text) =>
    appendFile(logFile, JSON.stringify({ ts: new Date().toISOString(), direction, text }) + "\n")
      .catch((err) => console.error(`[bridge] log write failed: ${err.message}`));

  console.log(`[bridge] client connected: ${client} — spawning pi (log: ${basename(logFile)})`);

  // stderr is inherited: Pi reserves stdout for protocol records and sends
  // diagnostics to stderr, so they land in this server's console.
  // PIRPC_LOG_FILE lets the time MCP default get_session_log to THIS session.
  const pi = spawn("pi", PI_ARGS, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PIRPC_LOG_FILE: logFile },
  });

  // Strict JSONL framing: split only on LF (Node's readline would also split
  // on U+2028/U+2029, which are legal inside JSON strings).
  let buffer = "";
  pi.stdout.setEncoding("utf8");
  pi.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === "message_end" && rec.message?.role === "assistant") {
          const text = (rec.message.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text) log("assistant", text);
        }
      } catch { /* malformed protocol line: forward it anyway */ }
      if (ws.readyState === ws.OPEN) ws.send(line);
    }
  });

  ws.on("message", (data) => {
    const text = data.toString();
    let rec;
    try {
      rec = JSON.parse(text); // validate only; forward the original bytes
    } catch {
      ws.send(JSON.stringify({ type: "response", command: "parse", success: false, error: "Invalid JSON" }));
      return;
    }
    if (rec.type === "prompt" && typeof rec.message === "string") log("user", rec.message);
    pi.stdin.write(text + "\n");
  });

  ws.on("close", () => {
    console.log(`[bridge] client disconnected: ${client} — stopping pi`);
    pi.stdin.end(); // closing stdin requests an orderly shutdown
    const killTimer = setTimeout(() => pi.kill("SIGTERM"), 3000);
    pi.once("exit", () => clearTimeout(killTimer));
  });

  pi.on("exit", (code, signal) => {
    console.log(`[bridge] pi exited for ${client}: code=${code} signal=${signal}`);
    if (ws.readyState === ws.OPEN) ws.close(1011, "pi exited");
  });

  pi.on("error", (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "bridge_error", error: `failed to start pi: ${err.message}` }));
      ws.close(1011, "pi spawn failed");
    }
  });
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] frontend A: http://localhost:${PORT}/frontend-a.html`);
  console.log(`[bridge] frontend B: http://localhost:${PORT}/frontend-b.html`);
});
