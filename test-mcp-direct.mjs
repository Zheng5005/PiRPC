// Deterministic checks for both MCP servers (no model involved).
// Run: node test-mcp-direct.mjs
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function connect(script) {
  const client = new Client({ name: "mcp-direct-test", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [script] }));
  return client;
}
const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: res.isError === true, text, json: res.isError ? null : JSON.parse(text) };
};

// --- fixture: a real .docx in uploads/ (LibreOffice converts txt -> docx) ---
const fixtureDir = await mkdtemp(join(tmpdir(), "pirpc-fixture-"));
await writeFile(join(fixtureDir, "fixture.txt"), "PiRPC conversion fixture\n");
await run("soffice", ["--headless", "--norestore", `-env:UserInstallation=file://${fixtureDir}/lo`, "--convert-to", "docx", "--outdir", "uploads", join(fixtureDir, "fixture.txt")], { timeout: 120_000 });

// --- time server ---
const time = await connect("mcp/time-server.mjs");

const utcIso = await call(time, "get_current_time", { timezone: "UTC", format: "iso" });
check("get_current_time UTC iso", !utcIso.isError && /T\d{2}:\d{2}:\d{2}Z$/.test(utcIso.json.value), utcIso.json?.value);

const unix = await call(time, "get_current_time", { timezone: "Asia/Tokyo", format: "unix" });
check("get_current_time unix", !unix.isError && /^\d{10}$/.test(unix.json.value), unix.json?.value);

const badTz = await call(time, "get_current_time", { timezone: "Mordor/Nowhere" });
check("invalid timezone rejected", badTz.isError && badTz.text.includes("Invalid IANA timezone"));

const conv = await call(time, "convert_time", { time: "2025-01-15T12:00", fromTimezone: "UTC", toTimezone: "America/Argentina/Buenos_Aires" });
check("convert UTC->ART (wall time)", !conv.isError && conv.json.to.value.includes("09:00"), conv.json?.to?.value);

const convOffset = await call(time, "convert_time", { time: "2025-01-15T12:00:00Z", fromTimezone: "UTC", toTimezone: "Asia/Tokyo" });
check("convert UTC->Tokyo (with offset)", !convOffset.isError && convOffset.json.to.value.includes("21:00") && convOffset.json.to.value.includes("+09:00"), convOffset.json?.to?.value);

// session log: real file + traversal rejection
await appendFile("logs/9999-test-fixture.jsonl", JSON.stringify({ ts: "2025-01-01T00:00:00Z", direction: "user", text: "first" }) + "\n" + JSON.stringify({ ts: "2025-01-01T00:01:00Z", direction: "assistant", text: "second" }) + "\n");
const logRes = await call(time, "get_session_log", { sessionFile: "9999-test-fixture.jsonl", limit: 1 });
check("get_session_log reads file, newest last", !logRes.isError && logRes.json.count === 1 && logRes.json.entries[0].text === "second");
const traversal = await call(time, "get_session_log", { sessionFile: "../package.json" });
check("get_session_log rejects traversal", traversal.isError);

await time.close();

// --- docx2pdf server ---
const d2p = await connect("mcp/docx2pdf-server.mjs");

const escape1 = await call(d2p, "convert_docx_to_pdf", { inputPath: "../secret.docx" });
check("docx2pdf rejects ../ escape", escape1.isError && escape1.text.includes("uploads/"));
const escape2 = await call(d2p, "convert_docx_to_pdf", { inputPath: "/etc/passwd" });
check("docx2pdf rejects absolute path", escape2.isError);
const badExt = await call(d2p, "convert_docx_to_pdf", { inputPath: "notes.txt" });
check("docx2pdf rejects non-Word extension", badExt.isError && badExt.text.includes(".docx"));

const conv2 = await call(d2p, "convert_docx_to_pdf", { inputPath: "fixture.docx" });
let pdfOk = false, head = "";
if (!conv2.isError) {
  head = await readFile("output/fixture.pdf", { encoding: "latin1" }).then((s) => s.slice(0, 5)).catch(() => "");
  pdfOk = head === "%PDF-";
}
check("docx2pdf converts fixture.docx", !conv2.isError && pdfOk, conv2.json?.downloadUrl ?? conv2.text.slice(0, 120));

await d2p.close();

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
