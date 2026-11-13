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

- T1 — S1, S2, S5 — Parent: implement delegate MCP server and deterministic direct tests — status: done — commit: `2f6f7c3`
- T2 — S3, S4, S5 — Parent: register delegate, route parent through it, update E2E assertions — status: implemented; E2E in T4 — commit: `6ac1099`
- T3 — S6 — Parent: document delegation architecture and operational configuration — status: done — commit: `53266f5`
- T4 — S1-S6 — Independent verifier + parent: run focused, full, and high-risk verification — status: blocked; parent checks complete, independent verifier unavailable — commit: N/A
- T5 — S2, S5 — Parent: expose codemode as the MCP transport in the restricted child and re-run real conversion — status: done — commit: `504880f`

## Log

- L1 — User request: "Puedes implementar el plan en docs/plan-subagent..."
- L2 — Source plan: `docs/plan-subagent-docx2pdf.md` (pre-existing untracked user file; preserved and excluded from work-unit commits).
- L3 — Exploration decision: extract the structured result from `tool_execution_end.result`, await `agent_settled`, then close RPC stdin; do not parse assistant prose or rely on `--print` to terminate an RPC child.
- L4 — Environment: Engram mirror unavailable because the installed binary predates the provider-required version; no write retry.
- L5 — Branch: `feat/docx2pdf-subagent`. Pre-existing untracked `docs/` and `pnpm-lock.yaml` are preserved and excluded from commits.
- L6 — RED: `node test-mcp-direct.mjs` failed because `mcp/delegate-server.mjs` did not exist. GREEN for T1: all 10 new delegate checks passed. The same command retains one unrelated UTC-format failure.
- L7 — Base comparison: a `git archive HEAD` scratch copy also failed `get_current_time UTC iso` with `+00:00` instead of `Z` (exit 1), proving that failure predates this feature. T1 syntax checks passed.
- L8 — T2: `server.mjs` excludes direct docx2pdf tools and adds parent-only delegation guidance; `.pi/mcp.json` registers the delegate with a 180-second MCP timeout; E2E now requires delegation and rejects a direct conversion call. Syntax and JSON checks passed.
- L9 — Delivery strategy: `auto-chain` if PRs are requested. T1 is an independent high-risk review slice at `2f6f7c3` (404 authored lines, coherent server + tests + tracking); later work units remain separate. No push or PR is authorized.
- L10 — T3: README documents the three-server architecture, parent-only prompt and exclusion, child lifecycle, model/timeout overrides, and deterministic versus real-model tests. `git diff --check` and balanced Markdown fence check passed.
- L11 — Independent verification unavailable: `gentle-ai-verify` rejected admission because its launch lacked a supported inline `Risk: item N` declaration. Runtime explicitly forbids retry; parent checks continue inline and missing independent proof will be reported.
- L12 — Initial inline direct run: all 10 delegate checks passed; the already-reproduced baseline UTC failure remains the only direct-test failure. `pi --list-models deepseek-v4.1-flash` found `opencode-go/deepseek-v4.1-flash`. Syntax, JSON, and `git diff --check` passed.
- L13 — Real E2E: parent called the delegate and direct docx2pdf was absent, but no PDF was produced; the delegate returned `Pi settled without a conversion result.` Exact child reproduction showed `mcp__docx2pdf` classified as a codemode server and the model emitting bash calls as text because codemode was not enabled. RED added for `codemode,mcp__docx2pdf__*`; only the updated allowlist check failed.
- L14 — Smoke baseline: the same `B received nothing from A's run` failure (3 records) occurs on a clean `origin/main` archive, so it predates this feature.
- L15 — Invalid verification attempt: the first post-fix E2E connected to an orphaned baseline server on port 3000 while the new server failed with `EADDRINUSE`; its direct-conversion result is not evidence about the fix. The orphan's cwd was verified as the parent-created baseline scratch directory before stopping PID 43756 with SIGTERM. A fresh bounded run is required.
- L16 — T5 GREEN: all 10 delegate checks passed after adding codemode; only the baseline UTC failure remains in the direct suite. Valid real E2E on a clean port exited 0 with all checks passing: time tool, upload, delegate rather than direct docx2pdf, downloadable `%PDF-` response, session log, and bridge log. Server PID 47593 was cleaned up by the runner trap.
- L17 — Work-unit history: T1 `2f6f7c3`; T2 `6ac1099`; T3 `53266f5`; T5 `504880f`. `auto-chain` slice boundaries remain one commit per work unit if PRs are requested. Final feature diff before this closure record: 461 insertions and 23 deletions across 8 files; no push or PR performed.
- L18 — Final cleanup and structural checks passed; port 3000 is free. Pre-existing untracked `docs/` and `pnpm-lock.yaml` remain untouched and uncommitted.
- L19 — Risk: item 2 (uploads/ confinement and restricted child-process execution). Independent verifier setup was rejected before any probes, so zero independent tests ran and that proof remains unavailable; all applicable parent-run checks are complete.
- L20 — User delivery request: "Incluye los cambios a docs y pnpm-lock a git, y haz un PR, con una size:exception si es necesaria." The source plan and the validated pnpm lockfile are now tracked; one PR is authorized even over 400 lines, with `size:exception`. No push or PR had been performed before this request. `pnpm install --lockfile-only --frozen-lockfile` reported `Already up to date`.
- L21 — Delivery: plan committed `8c4ecdc`, pnpm lockfile `1acd84d`; branch pushed. Issue #3 created for traceability and `size:exception` label created. Draft PR #4 opened with `type:feature` and `size:exception`: https://github.com/Zheng5005/PiRPC/pull/4. It stays draft because repo convention requires `status:approved` on the linked issue, which the parent did not self-approve; final diff is 1,425 additions + 23 deletions (1,448 changed lines).
