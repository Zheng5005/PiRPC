# Feature: Word → PDF conversion sub-agent
Implement the approved plan with deterministic tests, safe child-process cleanup, and reviewable work units.
High-risk surface: security confinement and tool restriction (Risk item 2).

## Specs

### S1 — Delegate MCP tool
"A new MCP tool (`delegate_docx2pdf_conversion`) spawns an isolated `pi` child process that handles the conversion and dies immediately after."

"Validate `inputPath` (same confinement rules as `docx2pdf-server.mjs`: must stay inside `uploads/`, must be `.docx` or `.doc`)"

"Read child stdout line by line, collect JSONL records"

"Kill child after timeout (120s) if it hasn't exited"

### S2 — Child configuration and prompt
"Spawn child: `pi --mode rpc --no-session --approve --print --model deepseek-v4.1-flash --tools mcp__docx2pdf__*`"

"Set child CWD to project root (so it finds `.pi/mcp.json`)"

"Send prompt via stdin: `{"id":"conv-1","type":"prompt","message":"Convert the file <inputPath> to PDF using the convert_docx_to_pdf tool. Return the PDF path and download URL."}`"

### S3 — Parent registration and routing
"`server.mjs` — PI_ARGS change"

"Add `--exclude-tools mcp__docx2pdf__*` to `PI_ARGS`"

"Register the delegate server"

### S4 — System prompt guidance
"When the user asks to convert a Word document to PDF, use the delegate_docx2pdf_conversion
tool. This delegates the conversion to a specialized sub-agent, keeping this conversation's
context clean."

### S5 — Required tests
"Delegate server rejects path traversal (`../secret.docx`)"
"Delegate server rejects absolute paths (`/etc/passwd`)"
"Delegate server rejects non-Word extensions (`notes.txt`)"
"Delegate server converts `fixture.docx` successfully and returns valid `downloadUrl`"
"Delegate server returns error for non-existent file"
"Update conversion test to verify the agent calls `mcp__delegate__delegate_docx2pdf_conversion` instead of `mcp__docx2pdf__convert_docx_to_pdf`"
"Verify PDF is still downloadable at `/output/<name>.pdf`"

### S6 — Documentation
"`README.md` | **Modify** | Document the sub-agent architecture"

## Tasks

- T1 — S1, S2, S5 — Parent: implement delegate MCP server and deterministic direct tests — status: done — commit: pending
- T2 — S3, S4, S5 — Parent: register delegate, route parent through it, update E2E assertions — status: implemented; E2E in T4 — commit: pending
- T3 — S6 — Parent: document delegation architecture and operational configuration — commit: pending
- T4 — S1-S6 — Independent verifier + parent: run focused, full, and high-risk verification — commit: N/A

## Log

- L1 — User request: "Puedes implementar el plan en docs/plan-subagent..."
- L2 — Source plan: `docs/plan-subagent-docx2pdf.md` (pre-existing untracked user file; preserved and excluded from work-unit commits).
- L3 — Exploration decision: extract the structured result from `tool_execution_end.result`, await `agent_settled`, then close RPC stdin; do not parse assistant prose or rely on `--print` to terminate an RPC child.
- L4 — Environment: Engram mirror unavailable because the installed binary predates the provider-required version; no write retry.
- L5 — Branch: `feat/docx2pdf-subagent`. Pre-existing untracked `docs/` and `pnpm-lock.yaml` are preserved and excluded from commits.
- L6 — RED: `node test-mcp-direct.mjs` failed because `mcp/delegate-server.mjs` did not exist. GREEN for T1: all 10 new delegate checks passed. The same command retains one unrelated UTC-format failure.
- L7 — Base comparison: a `git archive HEAD` scratch copy also failed `get_current_time UTC iso` with `+00:00` instead of `Z` (exit 1), proving that failure predates this feature. T1 syntax checks passed.
- L8 — T2: `server.mjs` excludes direct docx2pdf tools and adds parent-only delegation guidance; `.pi/mcp.json` registers the delegate with a 180-second MCP timeout; E2E now requires delegation and rejects a direct conversion call. Syntax and JSON checks passed.
