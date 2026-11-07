// Deterministic checks for both MCP servers over the bridge's streamable-HTTP
// endpoints (stateless, POST-only). No model involved. Requires the bridge on
// :3000 (npm start). Run: node test-mcp-http.mjs
import { appendFile, copyFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function connect(url, headers = {}) {
  const client = new Client({ name: "mcp-http-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}
const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: res.isError === true, text, json: res.isError ? null : JSON.parse(text) };
};

// --- time over /mcp/time ---
const fixtureLog = new URL("./logs/9999-http-fixture.jsonl", import.meta.url).pathname;
await appendFile(fixtureLog, JSON.stringify({ ts: "2025-06-01T10:00:00Z", direction: "user", text: "http fixture first" }) + "\n" + JSON.stringify({ ts: "2025-06-01T10:01:00Z", direction: "assistant", text: "http fixture second" }) + "\n");

const time = await connect("http://localhost:3000/mcp/time", { "X-Log-File": fixtureLog });
const tools = await time.listTools();
check("time lists 3 tools over HTTP", tools.tools?.length === 3, (tools.tools ?? []).map((t) => t.name).join(", "));

const now = await call(time, "get_current_time", { timezone: "Asia/Tokyo", format: "iso" });
check("get_current_time over HTTP", !now.isError && /\+09:00$/.test(now.json.value), now.json?.value);

const routed = await call(time, "get_session_log", { limit: 1 });
check("X-Log-File routes to the caller's log", !routed.isError && routed.json.file === "9999-http-fixture.jsonl" && routed.json.entries[0].text === "http fixture second");

await time.close();

// A client with an escaping header connects fine; the tool rejects the path.
const timeBad = await connect("http://localhost:3000/mcp/time", { "X-Log-File": "/tmp/evil.jsonl" });
const bad = await call(timeBad, "get_session_log", {});
check("escaping X-Log-File rejected by the tool", bad.isError && bad.text.includes("logs directory"));
await timeBad.close();

// --- docx2pdf over /mcp/docx2pdf, incl. queue under concurrency ---
const d2p = await connect("http://localhost:3000/mcp/docx2pdf");
const d2pTools = await d2p.listTools();
check("docx2pdf lists 1 tool over HTTP", d2pTools.tools?.length === 1, (d2pTools.tools ?? []).map((t) => t.name).join(", "));

await copyFile("uploads/fixture.docx", "uploads/q-a.docx").catch(() => { throw new Error("uploads/fixture.docx missing — run test-mcp-direct.mjs first"); });
await copyFile("uploads/fixture.docx", "uploads/q-b.docx");
await rm("output/q-a.pdf", { force: true });
await rm("output/q-b.pdf", { force: true });

const [convA, convB] = await Promise.all([
  call(d2p, "convert_docx_to_pdf", { inputPath: "q-a.docx" }),
  call(d2p, "convert_docx_to_pdf", { inputPath: "q-b.docx" }),
]);
const { readFile } = await import("node:fs/promises");
const head = async (p) => readFile(p, { encoding: "latin1" }).then((s) => s.slice(0, 5)).catch(() => "");
check("parallel conversions both succeed (queue)", !convA.isError && !convB.isError && (await head("output/q-a.pdf")) === "%PDF-" && (await head("output/q-b.pdf")) === "%PDF-");

const escape = await call(d2p, "convert_docx_to_pdf", { inputPath: "../package.json" });
check("docx2pdf rejects ../ over HTTP", escape.isError && escape.text.includes("uploads/"));

await d2p.close();

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
