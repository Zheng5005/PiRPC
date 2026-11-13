# Plan: Sub-agent for Word → PDF conversion

## Problem

When the user asks Pi to convert a Word document to PDF, the parent agent's context fills up with conversion details (tool calls, LibreOffice output, paths, errors) that add nothing to the ongoing conversation. This wastes context window and degrades chat quality over long sessions.

## Solution: Delegate to a child process

A new MCP tool (`delegate_docx2pdf_conversion`) spawns an isolated `pi` child process that handles the conversion and dies immediately after. The parent agent calls this tool instead of `convert_docx_to_pdf` directly, keeping its context clean.

### Architecture

```
User prompt → Pi Parent → calls delegate_docx2pdf_conversion (MCP tool)
                              ↓
                    delegate-server.mjs spawns:
                    pi --mode rpc --no-session --approve --print \
                       --model deepseek-v4.1-flash \
                       --tools mcp__docx2pdf__*
                              ↓
                    Child calls mcp__docx2pdf__convert_docx_to_pdf
                              ↓
                    Child returns result → child process exits
                              ↓
                    delegate-server.mjs extracts result
                              ↓
              Pi Parent receives { pdfPath, downloadUrl } → replies to user
```

### Sequence

1. User: "convert contract.docx to PDF"
2. Pi Parent decides to call `delegate_docx2pdf_conversion({ inputPath: "contract.docx" })`
3. `delegate-server.mjs` spawns a child `pi` process (model: `deepseek-v4.1-flash`, tools: `mcp__docx2pdf__*` only)
4. Child receives prompt: "Convert the file contract.docx to PDF using the convert_docx_to_pdf tool"
5. Child calls `mcp__docx2pdf__convert_docx_to_pdf`, gets result
6. Child outputs result via stdout JSONL, then exits (`--print` flag = one-shot)
7. `delegate-server.mjs` parses the child's JSONL output, extracts the PDF path and download URL
8. Returns the result to Pi Parent as a tool response
9. Pi Parent replies to the user with the download link

## Implementation

### Files to create or modify

| File | Action | Purpose |
|---|---|---|
| `mcp/delegate-server.mjs` | **Create** | MCP server that spawns child pi process for conversion |
| `.pi/mcp.json` | **Modify** | Register the delegate server |
| `server.mjs` | **Modify** | Add `--exclude-tools mcp__docx2pdf__*` to `PI_ARGS` |
| `test-mcp-direct.mjs` | **Modify** | Add tests for the delegate server |
| `README.md` | **Modify** | Document the sub-agent architecture |

### 1. `mcp/delegate-server.mjs`

New MCP server exposing one tool:

- **Tool name:** `delegate_docx2pdf_conversion`
- **Input:** `{ inputPath: string }` — file name or path inside `uploads/`
- **Behavior:**
  1. Validate `inputPath` (same confinement rules as `docx2pdf-server.mjs`: must stay inside `uploads/`, must be `.docx` or `.doc`)
  2. Spawn child: `pi --mode rpc --no-session --approve --print --model deepseek-v4.1-flash --tools mcp__docx2pdf__*`
  3. Set child CWD to project root (so it finds `.pi/mcp.json`)
  4. Send prompt via stdin: `{"id":"conv-1","type":"prompt","message":"Convert the file <inputPath> to PDF using the convert_docx_to_pdf tool. Return the PDF path and download URL."}`
  5. Read child stdout line by line, collect JSONL records
  6. Extract conversion result from the `message_end` record (the assistant's final response)
  7. Return `{ input, pdfPath, downloadUrl }` on success, or `{ error }` on failure
  8. Kill child after timeout (120s) if it hasn't exited
- **Output:** Same shape as `docx2pdf-server.mjs` result, so the parent can build the download link

### 2. `.pi/mcp.json`

```json
{
  "mcpServers": {
    "time": {
      "command": "node",
      "args": ["mcp/time-server.mjs"],
      "description": "Current time in any IANA timezone, time conversion between timezones, and the session message log with send timestamps"
    },
    "docx2pdf": {
      "command": "node",
      "args": ["mcp/docx2pdf-server.mjs"],
      "description": "Convert Word documents from uploads/ to PDF in output/ (LibreOffice headless)"
    },
    "delegate": {
      "command": "node",
      "args": ["mcp/delegate-server.mjs"],
      "description": "Delegate Word-to-PDF conversion to an isolated sub-agent (keeps parent context clean)"
    }
  }
}
```

### 3. `server.mjs` — PI_ARGS change

```diff
- const PI_ARGS = ["--mode", "rpc", "--no-session", "--approve"];
+ const PI_ARGS = ["--mode", "rpc", "--no-session", "--approve", "--exclude-tools", "mcp__docx2pdf__*"];
```

This forces the parent to use `delegate_docx2pdf_conversion` instead of calling `convert_docx_to_pdf` directly. The `docx2pdf` MCP server stays registered because the **child** process needs it.

### 4. System prompt guidance

Add to `.pi/instructions.md` or pass via `--append-system-prompt`:

```
When the user asks to convert a Word document to PDF, use the delegate_docx2pdf_conversion
tool. This delegates the conversion to a specialized sub-agent, keeping this conversation's
context clean.
```

## Child process configuration

| Setting | Value | Reason |
|---|---|---|
| `--mode rpc` | JSONL protocol over stdio | Programmatic control from delegate-server |
| `--no-session` | Ephemeral | No session persistence needed for one-shot work |
| `--approve` | Trust project `.pi/mcp.json` | Child needs access to `docx2pdf` MCP server |
| `--print` | One-shot | Process prompt and exit; child dies after completing work |
| `--model deepseek-v4.1-flash` | Lightweight model | Task is deterministic; no need for a heavy model |
| `--tools mcp__docx2pdf__*` | Only conversion tools | Minimal attack surface, minimal context pollution |

## Work units

| # | Scope | Commit message |
|---|---|---|
| 1 | `mcp/delegate-server.mjs` + tests | `feat: add delegate MCP server for docx2pdf sub-agent` |
| 2 | `.pi/mcp.json` + `server.mjs` | `feat: register delegate server and exclude direct docx2pdf from parent` |
| 3 | `README.md` | `docs: document sub-agent delegation architecture` |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Child process hangs | 120s timeout, then SIGTERM + SIGKILL fallback |
| Child fails to find MCP config | `--approve` + CWD set to project root |
| LibreOffice profile lock between concurrent conversions | Already handled: `docx2pdf-server.mjs` uses isolated profile per PID+timestamp |
| Parent calls `convert_docx_to_pdf` directly, bypassing delegation | `--exclude-tools mcp__docx2pdf__*` in parent's PI_ARGS prevents this |
| Child spawns with full tool set | `--tools mcp__docx2pdf__*` restricts to only the conversion tool |

## Test plan

1. **Unit (in `test-mcp-direct.mjs`):**
   - Delegate server rejects path traversal (`../secret.docx`)
   - Delegate server rejects absolute paths (`/etc/passwd`)
   - Delegate server rejects non-Word extensions (`notes.txt`)
   - Delegate server converts `fixture.docx` successfully and returns valid `downloadUrl`
   - Delegate server returns error for non-existent file

2. **E2E (in `test-e2e-mcp.mjs`):**
   - Update conversion test to verify the agent calls `mcp__delegate__delegate_docx2pdf_conversion` instead of `mcp__docx2pdf__convert_docx_to_pdf`
   - Verify PDF is still downloadable at `/output/<name>.pdf`
