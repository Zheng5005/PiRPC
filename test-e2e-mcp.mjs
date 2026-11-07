// End-to-end: browser -> bridge -> pi -> MCP tools, with a real model in the loop.
// Asserts on observable side effects (tool_execution_start events, files on disk,
// bridge log entries), never on model prose. Requires the bridge on :3000.
//
// waitFor matches ONLY records that arrive after the wait starts — an earlier
// agent_settled from a previous prompt must never resolve a later prompt's wait.
// Run: node test-e2e-mcp.mjs
import { readdir, readFile } from "node:fs/promises";

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const ws = new WebSocket("ws://localhost:3000/ws");
const records = [];
const waiters = [];
ws.onmessage = (e) => {
  const rec = JSON.parse(e.data);
  records.push(rec);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(rec)) { waiters[i].resolve(rec); waiters.splice(i, 1); }
  }
};
// Only future records can resolve a wait; no historical fast-path.
const waitFor = (pred, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
  waiters.push({ pred, resolve: (r) => { clearTimeout(timer); resolve(r); } });
});
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const prompt = async (message, toolFragment, label) => {
  const id = crypto.randomUUID();
  const startIdx = records.length;
  const settled = waitFor((r) => r.type === "agent_settled", 300_000, `${label} settled`);
  ws.send(JSON.stringify({ id, type: "prompt", message }));
  await waitFor((r) => r.type === "response" && r.id === id && r.success === true, 30_000, `${label} accepted`);
  await settled;
  const window = records.slice(startIdx);
  const tools = window.filter((r) => r.type === "tool_execution_start").map((r) => r.toolName);
  return { called: window.some((r) => r.type === "tool_execution_start" && String(r.toolName).includes(toolFragment)), tools };
};

// 1. time tool
const t1 = await prompt(
  "Use your time MCP tools to tell me the current time in Asia/Tokyo.",
  "mcp__time__get_current_time", "time prompt",
);
check("agent called mcp__time__get_current_time", t1.called, t1.called ? "" : `tools seen: ${t1.tools.join(", ") || "none"}`);

// 2. upload + docx2pdf
const fixture = await readFile("uploads/fixture.docx");
const up = await fetch(`http://localhost:3000/upload?name=${encodeURIComponent("e2e.docx")}`, { method: "POST", body: fixture }).then((r) => r.json());
check("upload e2e.docx", up.ok === true, up.path);

const t2 = await prompt(
  "Convert the Word document uploads/e2e.docx to PDF using your docx2pdf MCP tool.",
  "mcp__docx2pdf__convert_docx_to_pdf", "convert prompt",
);
check("agent called mcp__docx2pdf__convert_docx_to_pdf", t2.called, t2.called ? "" : `tools seen: ${t2.tools.join(", ") || "none"}`);
const dl = await fetch("http://localhost:3000/output/e2e.pdf");
check("converted PDF downloadable at /output/e2e.pdf", dl.status === 200 && (await dl.text()).startsWith("%PDF-"));

// 3. session log tool (defaults to this client's log via PIRPC_LOG_FILE)
const t3 = await prompt(
  "Using the get_session_log MCP tool, tell me the exact ISO timestamp of my first message in this session.",
  "mcp__time__get_session_log", "log prompt",
);
check("agent called mcp__time__get_session_log", t3.called, t3.called ? "" : `tools seen: ${t3.tools.join(", ") || "none"}`);

// 4. bridge log has both directions for this session
const newest = (await readdir("logs")).filter((n) => n.endsWith(".jsonl") && !n.startsWith("9999-")).sort().at(-1);
const entries = (await readFile(`logs/${newest}`, "utf8")).trim().split("\n").map(JSON.parse);
check("bridge log captured user + assistant messages",
  entries.some((e) => e.direction === "user" && e.text.includes("Asia/Tokyo")) &&
  entries.some((e) => e.direction === "assistant") &&
  entries.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.ts)),
  `${entries.length} entries in ${newest}`);

ws.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
