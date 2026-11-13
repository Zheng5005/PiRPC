#!/usr/bin/env node
// Deterministic stand-in for a Pi RPC child used by test-mcp-direct.mjs.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const recordFile = process.env.PIRPC_FAKE_PI_RECORD;
const behavior = process.env.PIRPC_FAKE_PI_BEHAVIOR ?? "success";
const record = (value) => {
  if (recordFile) appendFileSync(recordFile, JSON.stringify(value) + "\n");
};

record({ args: process.argv.slice(2) });
if (behavior === "timeout") {
  process.on("SIGTERM", () => {
    record({ signal: "SIGTERM" });
    process.exit(0);
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const prompt = JSON.parse(line);
  record({ prompt });

  if (behavior === "exit") process.exit(17);
  if (behavior !== "timeout") {
    console.log(JSON.stringify({ type: "response", id: prompt.id, command: "prompt", success: true }));
  }

  if (behavior === "success") {
    const conversion = {
      input: "fixture.docx",
      pdfPath: `${process.cwd()}/output/fixture.pdf`,
      downloadUrl: "/output/fixture.pdf",
      soffice: "fake conversion",
    };
    console.log(JSON.stringify({
      type: "tool_execution_end",
      toolName: "mcp__docx2pdf__convert_docx_to_pdf",
      result: { content: [{ type: "text", text: JSON.stringify(conversion) }] },
    }));
  }
  if (behavior !== "timeout") console.log(JSON.stringify({ type: "agent_settled" }));
});
