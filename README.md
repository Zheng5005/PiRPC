# PiRPC — two HTML frontends over Pi RPC mode, with MCP tools

Two framework-free HTML chat frontends that talk to [Pi](https://github.com/earendil-works/pi) through its RPC mode, extended with two project-local MCP servers (time + Word→PDF).

## Architecture

```
frontend-a.html ─┐
                 ├─ WebSocket ── server.mjs ── stdio JSONL ── pi --mode rpc --no-session --approve  (one child per client)
frontend-b.html ─┘                     │              │
                 POST /upload ─────────┘              └─ MCP (project .pi/mcp.json):
                 GET  /output/<pdf>                        mcp/time-server.mjs      → mcp__time__*
                                                           mcp/docx2pdf-server.mjs → mcp__docx2pdf__*
```

- Pi's RPC mode is a JSONL protocol over stdin/stdout; a browser cannot reach a subprocess, so `server.mjs` bridges both sides.
- **One `pi` child process per WebSocket connection** → each frontend has a fully independent session.
- `--approve` makes each child trust the project `.pi/mcp.json`; the user-level pi configuration is untouched.

## MCP servers

| Server | Tools | Notes |
|---|---|---|
| `time` | `get_current_time`, `convert_time`, `get_session_log` | Any IANA timezone via `Intl`; formats `iso`/`unix`/`locale`/`human`; the log tool defaults to the calling client's own session log (`PIRPC_LOG_FILE`) |
| `docx2pdf` | `convert_docx_to_pdf` | LibreOffice headless (`soffice`), input confined to `uploads/`, output in `output/` |

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
node test-mcp-direct.mjs   # deterministic MCP checks: zones, formats, confinement, real conversion (also creates uploads/fixture.docx)
node test-smoke.mjs        # bridge basics: two clients, independent sessions
node test-e2e-mcp.mjs      # full stack with a model: time query, upload+convert, log query (run test-mcp-direct first: reuses its fixture)
```

## References

- Pi RPC mode: `pi --mode rpc --no-session`; protocol docs under the pi-coding-agent package (`docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/mcp.md`).
