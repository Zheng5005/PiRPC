#!/usr/bin/env node
// MCP server: convert Word documents to PDF with the system LibreOffice.
//
// Confinement: input must resolve inside uploads/ and be .docx/.doc; output
// always lands in output/ (served by the bridge as /output/<file>.pdf).
// Each conversion uses an isolated LibreOffice profile so concurrent
// conversions from several pi children don't fight over one profile lock.

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const run = promisify(execFile);
const UPLOADS_DIR = resolve(new URL("../uploads/", import.meta.url).pathname);
const OUTPUT_DIR = resolve(new URL("../output/", import.meta.url).pathname);
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

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

const server = new McpServer({ name: "pirpc-docx2pdf", version: "0.1.0" });

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
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ input: basename(input), pdfPath, downloadUrl: `/output/${encodeURIComponent(pdfName)}`, soffice: stdout.trim() }, null, 2),
        }],
      };
    } catch (err) {
      const detail = err.stderr?.trim() || err.message;
      return { content: [{ type: "text", text: `Error: ${detail}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
