# PiRPC — two HTML frontends over Pi RPC mode, with MCP tools

Two framework-free HTML chat frontends that talk to [Pi](https://github.com/earendil-works/pi) through its RPC mode, extended with two MCP servers (time + Word→PDF) hosted by the bridge over **streamable HTTP**.

## Architecture

```
frontend-a.html ─┐
                 ├─ WebSocket ─ server.mjs ─ stdio JSONL ─ pi --mode rpc --no-session  (one child per client)
frontend-b.html ─┘         │                    │
        POST /upload ──────┘                    └─ MCP over streamable HTTP (stateless):
        GET  /output/<pdf>                          /mcp/time      → mcp__time__*
        POST /mcp/time, /mcp/docx2pdf               /mcp/docx2pdf  → mcp__docx2pdf__*
```

- Pi's RPC mode is a JSONL protocol over stdin/stdout; a browser cannot reach a subprocess, so `server.mjs` bridges both sides.
- **One `pi` child process per WebSocket connection** → each frontend has a fully independent session.
- **The MCP servers run in-process behind the bridge** (stateless streamable HTTP, POST-only, JSON responses): the pi children connect to `http://localhost:3000/mcp/*`, so no server processes are spawned per client. The same server files still run standalone: `node mcp/time-server.mjs` (stdio, default) or `--http-port N` (own HTTP listener).

## MCP servers

| Endpoint | Tools | Notes |
|---|---|---|
| `/mcp/time` | `get_current_time`, `convert_time`, `get_session_log` | Any IANA timezone via `Intl`; formats `iso`/`unix`/`locale`/`human` |
| `/mcp/docx2pdf` | `convert_docx_to_pdf` | LibreOffice headless (`soffice`); input confined to `uploads/`, output in `output/`; conversions serialized through a queue |

**Per-session log routing:** each pi child inherits `PIRPC_LOG_FILE` (its client's log path) from the bridge and expands it into the `X-Log-File` request header (`.pi/mcp.json` uses `${PIRPC_LOG_FILE:-}`, which stays resolvable when pi runs outside the bridge — the tool then falls back). The header is validated to stay inside `logs/`.

Note: the MCP urls in `.pi/mcp.json` hardcode port 3000; if you change `PORT`, update them too.

## Message logs

Every prompt and every final assistant message is appended to `logs/<timestamp>-<id>.jsonl` with an ISO 8601 `ts`. The frontends also show a local timestamp under each bubble, and the agent can answer "at what time did I send X?" via `get_session_log`.

## Word → PDF flow

1. In the frontend, click 📎 and pick a `.docx`/`.doc` → `POST /upload` saves it into `uploads/` (25 MB max, extension + basename validated).
2. Ask Pi: "convert `<name>` to PDF" → the agent calls `mcp__docx2pdf__convert_docx_to_pdf`.
3. The reply includes `/output/<name>.pdf`, rendered as a download link in the chat.

## Run

```bash
npm install
npm start          # http://localhost:3000 (PORT env var to change)
```

## Tests

```bash
npm test                   # test-mcp-direct (stdio servers: zones, confinement, conversion)
                           # + test-smoke (bridge basics, two independent clients)
node test-mcp-http.mjs     # MCP over the bridge's HTTP endpoints: routing header, guards, queue (bridge must be running)
node test-e2e-mcp.mjs      # full stack with a model: time query, upload+convert, per-session log routing (bridge running; run npm test first for the fixture)
```

Inspect the MCP connections like pi sees them: `pi mcp list` from this directory (the parent `Projects/` path is trusted in `~/.pi/agent/trust.json`).

## References

- Pi RPC mode: `pi --mode rpc --no-session`; protocol docs under the pi-coding-agent package (`docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/mcp.md`).
