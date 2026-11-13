# PiRPC — two HTML frontends over Pi RPC mode, with MCP tools

Two framework-free HTML chat frontends that talk to [Pi](https://github.com/earendil-works/pi) through its RPC mode, extended with project-local MCP servers for time and Word→PDF conversion. Word conversion runs in an ephemeral Pi sub-agent so conversion details stay out of the parent conversation.

## Architecture

```
frontend-a.html ─┐
                 ├─ WebSocket ── server.mjs ── stdio JSONL ── parent pi (one child per client)
frontend-b.html ─┘                     │                    │
                 POST /upload ─────────┘                    ├─ mcp__time__*
                 GET  /output/<pdf>                         └─ mcp__delegate__*
                                                                   │
                                      ephemeral pi child ──────────┘
                                      (--tools codemode,mcp__docx2pdf__*)
                                               │
                                               └─ convert_docx_to_pdf → LibreOffice
```

- Pi's RPC mode is a JSONL protocol over stdin/stdout; a browser cannot reach a subprocess, so `server.mjs` bridges both sides.
- **One `pi` child process per WebSocket connection** → each frontend has a fully independent session.
- `--approve` makes each child trust the project `.pi/mcp.json`; the user-level pi configuration is untouched.
- The parent starts with `--exclude-tools mcp__docx2pdf__*`, so Word conversion must go through the delegate. The conversion server remains registered for the isolated child.

## MCP servers

| Server | Tools | Notes |
|---|---|---|
| `time` | `get_current_time`, `convert_time`, `get_session_log` | Any IANA timezone via `Intl`; formats `iso`/`unix`/`locale`/`human`; the log tool defaults to the calling client's own session log (`PIRPC_LOG_FILE`) |
| `docx2pdf` | `convert_docx_to_pdf` | LibreOffice headless (`soffice`), input confined to `uploads/`, output in `output/`; hidden from the bridge's parent Pi |
| `delegate` | `delegate_docx2pdf_conversion` | Spawns an ephemeral Pi RPC child restricted to `codemode` + `mcp__docx2pdf__*` (no shell or filesystem tools), then returns only `{ input, pdfPath, downloadUrl }` |

## Message logs

Every prompt and every final assistant message is appended to `logs/<timestamp>-<id>.jsonl` with an ISO 8601 `ts`. The frontends also show a local timestamp under each bubble, and the agent can answer "at what time did I send X?" via `get_session_log`.

## Word → PDF flow

1. In the frontend, click 📎 and pick a `.docx`/`.doc` → `POST /upload` saves it into `uploads/` (25 MB max, extension + basename validated).
2. Ask Pi: "convert `<name>` to PDF" → the parent calls `mcp__delegate__delegate_docx2pdf_conversion`.
3. The delegate starts `pi --mode rpc --no-session --approve --model deepseek-v4.1-flash --tools codemode,mcp__docx2pdf__*`. The child calls `convert_docx_to_pdf` through `codemode` (the MCP transport in this Pi installation); after `agent_settled`, the delegate closes RPC stdin and reaps the child.
4. Only the structured conversion result returns to the parent. The reply includes `/output/<name>.pdf`, rendered as a download link in the chat.

The delegate validates the same `uploads/` confinement and Word extensions as the conversion server. It terminates a child after 120 seconds (configurable with `PIRPC_DELEGATE_TIMEOUT_MS`), with `SIGTERM` followed by a `SIGKILL` fallback. Set `PIRPC_DELEGATE_MODEL` if the default model is not configured; `PIRPC_PI_BIN` overrides the Pi executable, primarily for deterministic tests.

## Run

```bash
npm install
npm start          # http://localhost:3000 (PORT env var to change)
```

## Tests

```bash
node test-mcp-direct.mjs   # deterministic MCP checks; real direct conversion + fake Pi for delegation (creates uploads/fixture.docx)
node test-smoke.mjs        # bridge basics: two clients, independent sessions (bridge must be running)
node test-e2e-mcp.mjs      # real models: time, delegated upload+convert, log query (bridge running; direct test first)

# Override the delegate's model for a real E2E run when needed:
PIRPC_DELEGATE_MODEL=<provider/model> npm start
```

## References

- Pi RPC mode: `pi --mode rpc --no-session`; protocol docs under the pi-coding-agent package (`docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/mcp.md`).
