#!/usr/bin/env node
// MCP server: convert Word documents to PDF with the system LibreOffice.
//
// Dual transport:
//   node mcp/docx2pdf-server.mjs                 (stdio, default — tests and pi child use)
//   node mcp/docx2pdf-server.mjs --http-port N   (standalone streamable HTTP, stateless)
//
// Confinement: input must resolve inside uploads/ and be .docx/.doc; output
// always lands in output/ (served by the bridge as /output/<file>.pdf).
// Conversions run through a serial queue: one shared server means one
// LibreOffice runner, so concurrent requests must not stampede the CPU.
// Each conversion still uses an isolated LibreOffice profile.

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createStatelessHandler, serveHttp } from "./stateless-http.mjs";

const run = promisify(execFile);
const UPLOADS_DIR = resolve(new URL("../uploads/", import.meta.url).pathname);
const OUTPUT_DIR = resolve(new URL("../output/", import.meta.url).pathname);
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

// Serialize conversions: shared server, one LibreOffice runner at a time.
let conversionQueue = Promise.resolve();
function enqueueConversion(task) {
  const result = conversionQueue.then(task);
  conversionQueue = result.catch(() => {}); // a failure must not stall the queue
  return result;
}

function resolveUpload(inputPath) {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new Error("Invalid inputPath.");
  }
  const resolved = resolve(UPLOADS_DIR, inputPath);
  if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + sep)) {
    throw new Error(`inputPath must stay inside uploads/ (got "${inputPath}").`);
  }
  if (!/\.(docx|doc)$/i.test(resolved)) {
    throw new Error("Only .docx and .doc files are supported.");
  }
  return resolved;
}

async function convertToPdf(inputPath) {
  const input = resolveUpload(inputPath);
  await access(input);
  const profile = `-env:UserInstallation=file:///tmp/lo-pirpc-${process.pid}-${Date.now()}`;
  const { stdout } = await run(
    "soffice",
    ["--headless", "--norestore", profile, "--convert-to", "pdf", "--outdir", OUTPUT_DIR, input],
    { timeout: 120_000 },
  );
  const pdfName = `${basename(input, extname(input))}.pdf`;
  const pdfPath = join(OUTPUT_DIR, pdfName);
  await access(pdfPath); // fail loudly if LibreOffice reported success but wrote nothing
  return { input: basename(input), pdfPath, downloadUrl: `/output/${encodeURIComponent(pdfName)}`, soffice: stdout.trim() };
}

// Fresh server instance with the tool; reused by stdio and every HTTP request.
export function buildDocx2PdfServer() {
  const server = new McpServer({ name: "pirpc-docx2pdf", version: "0.2.0" });

  server.registerTool(
    "convert_docx_to_pdf",
    {
      description: "Convert a Word document from uploads/ to PDF in output/. Returns the PDF path and its download URL on the bridge.",
      inputSchema: {
        inputPath: z.string().describe('File name (or path inside uploads/) of the .docx/.doc to convert, e.g. "contract.docx".'),
      },
    },
    async ({ inputPath }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await enqueueConversion(() => convertToPdf(inputPath)), null, 2) }] };
      } catch (err) {
        const detail = err.stderr?.trim() || err.message;
        return { content: [{ type: "text", text: `Error: ${detail}` }], isError: true };
      }
    },
  );

  return server;
}

// HTTP entry used by the bridge.
export const handleDocxHttp = createStatelessHandler(buildDocx2PdfServer);

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--http-port"));
  if (portArg) {
    const port = Number(portArg.includes("=") ? portArg.split("=")[1] : args[args.indexOf(portArg) + 1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error("--http-port needs a valid port number");
      process.exit(2);
    }
    serveHttp(handleDocxHttp, port);
    console.error(`[pirpc-docx2pdf] streamable HTTP (stateless) on http://localhost:${port}/ — POST only`);
    return;
  }
  const server = buildDocx2PdfServer();
  await server.connect(new StdioServerTransport());
}

if (isMain()) {
  await main();
}
