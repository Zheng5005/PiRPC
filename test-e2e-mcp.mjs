// End-to-end: browser -> bridge -> pi -> MCP tools over streamable HTTP,
// with a real model in the loop. Requires the bridge on :3000 and
// uploads/fixture.docx from test-mcp-direct.mjs. Run: node test-e2e-mcp.mjs
//
// The routing section proves per-session log routing end to end: two clients
// ask for the timestamp of their own first message; each answer must quote
// the first user timestamp from THAT client's own bridge log, and A's log
// must not grow while B runs.
import { readdir, readFile } from "node:fs/promises";

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const logsDir = new URL("./logs/", import.meta.url).pathname;
const sessionLogs = async () =>
  (await readdir(logsDir)).filter((n) => n.endsWith(".jsonl") && !n.startsWith("9999-") && !n.startsWith("mcp-time-errors"));
const readLog = async (name) => (await readFile(logsDir + name, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

function makeClient() {
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
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  async function prompt(message, toolFragment, label) {
    const id = crypto.randomUUID();
    const startIdx = records.length;
    const settled = waitFor((r) => r.type === "agent_settled", 300_000, `${label} settled`);
    ws.send(JSON.stringify({ id, type: "prompt", message }));
    await waitFor((r) => r.type === "response" && r.id === id && r.success === true, 30_000, `${label} accepted`);
    await settled;
    const window = records.slice(startIdx);
    const tools = window.filter((r) => r.type === "tool_execution_start").map((r) => r.toolName);
    return { called: window.some((r) => r.type === "tool_execution_start" && String(r.toolName).includes(toolFragment)), tools };
  }
  return { ws, records, open, prompt };
}

const lastAssistantText = (records) => {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "message_end" && r.message?.role === "assistant") {
      return (r.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    }
  }
  return "";
};

const logsBefore = new Set(await sessionLogs());

// --- client A: time, upload + convert, own log ---
const a = makeClient();
await a.open;

const t1 = await a.prompt(
  "Use your time MCP tools to tell me the current time in Asia/Tokyo.",
  "mcp__time__get_current_time", "time prompt",
);
check("A: agent called mcp__time__get_current_time", t1.called, t1.called ? "" : `tools seen: ${t1.tools.join(", ") || "none"}`);

const fixture = await readFile("uploads/fixture.docx");
const up = await fetch(`http://localhost:3000/upload?name=${encodeURIComponent("e2e.docx")}`, { method: "POST", body: fixture }).then((r) => r.json());
check("upload e2e.docx", up.ok === true, up.path);

const t2 = await a.prompt(
  "Convert the Word document uploads/e2e.docx to PDF using your docx2pdf MCP tool.",
  "mcp__docx2pdf__convert_docx_to_pdf", "convert prompt",
);
check("A: agent called mcp__docx2pdf__convert_docx_to_pdf", t2.called, t2.called ? "" : `tools seen: ${t2.tools.join(", ") || "none"}`);
const dl = await fetch("http://localhost:3000/output/e2e.pdf");
check("converted PDF downloadable at /output/e2e.pdf", dl.status === 200 && (await dl.text()).startsWith("%PDF-"));

const t3 = await a.prompt(
  "Using the get_session_log MCP tool, tell me the exact ISO timestamp of my first message in this session.",
  "mcp__time__get_session_log", "log prompt A",
);
check("A: agent called mcp__time__get_session_log", t3.called, t3.called ? "" : `tools seen: ${t3.tools.join(", ") || "none"}`);

const newLogsA = (await sessionLogs()).filter((n) => !logsBefore.has(n));
check("A: exactly one new session log", newLogsA.length === 1, newLogsA.join(", "));
const aLog = newLogsA[0];
const aEntries = await readLog(aLog);
const aFirstTs = aEntries.find((e) => e.direction === "user")?.ts ?? "";
const aAnswer = lastAssistantText(a.records);
check("A: answer quotes A's own first-message timestamp", aFirstTs && aAnswer.includes(aFirstTs.slice(0, 19)), `${aFirstTs} from ${aLog}`);
check("A: log captured both directions with ISO ts",
  aEntries.some((e) => e.direction === "assistant") && aEntries.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.ts)),
  `${aEntries.length} entries`);

a.ws.close();

// --- client B: independent session, own log routing ---
const b = makeClient();
await b.open;

const t4 = await b.prompt(
  "Using the get_session_log MCP tool, tell me the exact ISO timestamp of my first message in this session.",
  "mcp__time__get_session_log", "log prompt B",
);
check("B: agent called mcp__time__get_session_log", t4.called, t4.called ? "" : `tools seen: ${t4.tools.join(", ") || "none"}`);

const newLogsB = (await sessionLogs()).filter((n) => !logsBefore.has(n) && n !== aLog);
check("B: exactly one more new session log", newLogsB.length === 1, newLogsB.join(", "));
const bLog = newLogsB[0];
const bEntries = await readLog(bLog);
const bFirstTs = bEntries.find((e) => e.direction === "user")?.ts ?? "";
const bAnswer = lastAssistantText(b.records);
check("B: answer quotes B's own first-message timestamp", bFirstTs && bAnswer.includes(bFirstTs.slice(0, 19)), `${bFirstTs} from ${bLog}`);
check("B: session distinct from A", bFirstTs && bFirstTs !== aFirstTs, `${aFirstTs} vs ${bFirstTs}`);

const aEntriesAfter = await readLog(aLog);
check("A's log unchanged after B's session", aEntriesAfter.length === aEntries.length, `${aEntries.length} -> ${aEntriesAfter.length}`);

b.ws.close();

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
