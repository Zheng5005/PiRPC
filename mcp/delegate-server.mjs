#!/usr/bin/env node
// MCP server: delegate Word → PDF conversion to an ephemeral Pi RPC child.
//
// Only the structured docx2pdf tool result crosses the process boundary. Pi's
// reasoning, tool output, and diagnostics stay out of the parent's context.

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PROJECT_ROOT = resolve(new URL("../", import.meta.url).pathname);
const UPLOADS_DIR = resolve(new URL("../uploads/", import.meta.url).pathname);
const PI_BIN = process.env.PIRPC_PI_BIN ?? "pi";
const MODEL = process.env.PIRPC_DELEGATE_MODEL ?? "deepseek-v4.1-flash";
const TIMEOUT_MS = Number(process.env.PIRPC_DELEGATE_TIMEOUT_MS ?? 120_000);
const SHUTDOWN_GRACE_MS = 3_000;
const KILL_GRACE_MS = 3_000;
const CONVERSION_TOOL = "mcp__docx2pdf__convert_docx_to_pdf";
const MAX_STDERR_CHARS = 8_000;

await mkdir(UPLOADS_DIR, { recursive: true });

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

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseConversion(result) {
  const text = resultText(result);
  if (!text) throw new Error("The conversion tool returned no text result.");
  const value = JSON.parse(text);
  if (typeof value.pdfPath !== "string" || !value.pdfPath ||
      typeof value.downloadUrl !== "string" || !value.downloadUrl) {
    throw new Error("The conversion tool result is missing pdfPath or downloadUrl.");
  }
  return {
    input: typeof value.input === "string" && value.input ? value.input : basename(value.pdfPath, extname(value.pdfPath)),
    pdfPath: value.pdfPath,
    downloadUrl: value.downloadUrl,
  };
}

async function convertWithChild(inputPath) {
  const input = resolveUpload(inputPath);
  await access(input);

  const args = [
    "--mode", "rpc",
    "--no-session",
    "--approve",
    "--model", MODEL,
    // This Pi installation exposes MCP calls through codemode. The allowlist
    // still excludes bash, filesystem tools, and every other MCP server.
    "--tools", "codemode,mcp__docx2pdf__*",
  ];

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(PI_BIN, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let conversion;
    let conversionCount = 0;
    let failure;
    let settled = false;
    let shuttingDown = false;
    let timedOut = false;
    let finished = false;
    let stderr = "";
    let shutdownTimer;
    let killTimer;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, TIMEOUT_MS);

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
      if (error) rejectResult(error);
      else resolveResult(value);
    }

    function terminate() {
      if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
      clearTimeout(shutdownTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }

    function beginShutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      child.stdin.end();
      shutdownTimer = setTimeout(terminate, SHUTDOWN_GRACE_MS);
    }

    function processRecord(record) {
      if (record.type === "response" && record.id === "conv-1" && record.success === false) {
        throw new Error(`Pi rejected the conversion prompt: ${record.error ?? "unknown RPC error"}`);
      }

      if (record.type === "tool_execution_end" && record.toolName === CONVERSION_TOOL) {
        conversionCount += 1;
        if (conversionCount > 1) throw new Error("The child returned multiple conversion results.");
        if (record.isError === true || record.result?.isError === true) {
          throw new Error(resultText(record.result) || "The conversion tool failed.");
        }
        conversion = parseConversion(record.result);
      }

      if (record.type === "agent_settled") {
        settled = true;
        beginShutdown();
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        try {
          processRecord(JSON.parse(line));
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
          beginShutdown();
          break;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    child.stdin.on("error", (err) => {
      if (!shuttingDown && !finished) {
        failure = err;
        terminate();
      }
    });

    child.once("error", (err) => {
      if (child.pid) {
        failure = err;
        terminate();
      } else {
        finish(new Error(`Failed to start Pi: ${err.message}`));
      }
    });

    child.once("exit", (code, signal) => {
      const detail = stderr.trim();
      if (timedOut) {
        finish(new Error(`Pi conversion timed out after ${TIMEOUT_MS}ms.${detail ? ` ${detail}` : ""}`));
      } else if (failure) {
        finish(failure);
      } else if (!settled) {
        finish(new Error(`Pi exited before settling (code=${code} signal=${signal}).${detail ? ` ${detail}` : ""}`));
      } else if (code !== 0) {
        finish(new Error(`Pi conversion child failed (code=${code} signal=${signal}).${detail ? ` ${detail}` : ""}`));
      } else if (!conversion) {
        finish(new Error("Pi settled without a conversion result."));
      } else {
        finish(null, conversion);
      }
    });

    const prompt = `Convert the file ${inputPath} to PDF using the convert_docx_to_pdf tool. Return the PDF path and download URL.`;
    child.stdin.write(JSON.stringify({ id: "conv-1", type: "prompt", message: prompt }) + "\n");
  });
}

const server = new McpServer({ name: "pirpc-docx2pdf-delegate", version: "0.1.0" });

server.registerTool(
  "delegate_docx2pdf_conversion",
  {
    description: "Convert a Word document from uploads/ in an isolated Pi sub-agent. Returns only the PDF path and download URL.",
    inputSchema: {
      inputPath: z.string().describe('File name (or path inside uploads/) of the .docx/.doc to convert, e.g. "contract.docx".'),
    },
  },
  async ({ inputPath }) => {
    try {
      const result = await convertWithChild(inputPath);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const detail = err.stderr?.trim() || err.message;
      return { content: [{ type: "text", text: `Error: ${detail}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
