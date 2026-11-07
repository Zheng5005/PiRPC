#!/usr/bin/env node
// MCP server: current time in any IANA timezone, conversion between timezones,
// and read access to the bridge's per-session message log.
//
// Dual transport:
//   node mcp/time-server.mjs                 (stdio, default — tests and pi child use)
//   node mcp/time-server.mjs --http-port N   (standalone streamable HTTP, stateless)
//
// Over HTTP the bridge sends X-Log-File (absolute path of the calling client's
// log) per request; get_session_log defaults to it. The header is validated to
// stay inside logs/, so a direct caller cannot point the tool anywhere else.
// Over stdio, PIRPC_LOG_FILE from the environment plays the same role.

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createStatelessHandler, serveHttp } from "./stateless-http.mjs";

const LOG_DIR = new URL("../logs/", import.meta.url).pathname;
mkdirSync(LOG_DIR, { recursive: true });

// Carries { logFile } from the HTTP request through to the tool handlers.
const requestContext = new AsyncLocalStorage();

const FORMATS = ["iso", "unix", "locale", "human"];

function assertTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone: "${tz}". Example: "America/Argentina/Buenos_Aires".`);
  }
}

function partsInZone(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
}

function offsetLabel(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
  const name = dtf.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "Z" : name.replace("GMT", "");
}

function formatInZone(date, tz, format) {
  assertTimeZone(tz);
  switch (format) {
    case "unix":
      return String(Math.floor(date.getTime() / 1000));
    case "iso": {
      const p = partsInZone(date, tz);
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetLabel(date, tz)}`;
    }
    case "locale":
      return date.toLocaleString("en-US", { timeZone: tz });
    case "human":
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(date);
    default:
      throw new Error(`Unknown format "${format}". Use one of: ${FORMATS.join(", ")}.`);
  }
}

// Offset (ms) of timezone `tz` at instant `date`: wall-clock-in-tz minus UTC.
function zoneOffsetMs(date, tz) {
  const p = partsInZone(date, tz);
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  return wallAsUtc - instant;
}

// Interpret "2025-01-15T12:00[:00]" (no offset) as wall time in `tz`.
function wallTimeToUtc(input, tz) {
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`Unrecognized time "${input}". Use ISO 8601 or unix seconds.`);
  const [, y, mo, d, h, mi, s = "0"] = m;
  let guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  for (let i = 0; i < 3; i++) {
    const candidate = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - zoneOffsetMs(new Date(guess), tz);
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

function parseTime(input, fromTz) {
  if (/^\d{9,13}$/.test(input.trim())) {
    const n = Number(input.trim());
    return new Date(n > 1e12 ? n : n * 1000); // allow unix seconds or milliseconds
  }
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(input.trim());
  if (hasOffset) {
    const d = new Date(input.trim());
    if (Number.isNaN(d.getTime())) throw new Error(`Unparseable time "${input}".`);
    return d;
  }
  assertTimeZone(fromTz);
  return wallTimeToUtc(input.trim(), fromTz);
}

// sessionFile parameter: a bare .jsonl file name inside logs/.
function resolveLogName(name) {
  if (basename(name) !== name || !name.endsWith(".jsonl")) {
    throw new Error("sessionFile must be a .jsonl file name inside the logs directory.");
  }
  return join(LOG_DIR, name);
}

// Header/env values: absolute paths, validated to stay inside logs/.
function resolveLogAbsolute(p) {
  if (typeof p !== "string" || p.includes("\0") || !p.endsWith(".jsonl")) {
    throw new Error("Log path must be a .jsonl file inside the logs directory.");
  }
  const resolved = resolve(p);
  if (!resolved.startsWith(resolve(LOG_DIR) + sep)) {
    throw new Error("Log path escapes the logs directory.");
  }
  return resolved;
}

async function readSessionLog({ sessionFile, limit, contextLog }) {
  let file;
  if (sessionFile) {
    file = resolveLogName(sessionFile);
  } else if (contextLog) {
    file = resolveLogAbsolute(contextLog);
  } else if (process.env.PIRPC_LOG_FILE) {
    file = resolveLogAbsolute(process.env.PIRPC_LOG_FILE);
  } else {
    const names = (await readdir(LOG_DIR).catch(() => [])).filter((n) => n.endsWith(".jsonl") && !n.startsWith("mcp-time-errors"));
    if (names.length === 0) throw new Error("No session logs found yet.");
    file = join(LOG_DIR, names.sort().at(-1)); // timestamped names sort chronologically
  }
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const entries = lines.slice(-limit).map((l) => JSON.parse(l));
  return { file: basename(file), count: entries.length, entries };
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });

// Fresh server instance with all tools; reused by stdio and every HTTP request.
export function buildTimeServer() {
  const server = new McpServer({ name: "pirpc-time", version: "0.2.0" });

  server.registerTool(
    "get_current_time",
    {
      description: "Current date and time in any IANA timezone, in several formats.",
      inputSchema: {
        timezone: z.string().optional().describe('IANA timezone, e.g. "Asia/Tokyo". Default: "UTC".'),
        format: z.enum(FORMATS).optional().describe('Output format: "iso", "unix", "locale" or "human". Default: "iso".'),
      },
    },
    async ({ timezone = "UTC", format = "iso" }) => {
      try {
        const now = new Date();
        return ok({ timezone, format, value: formatInZone(now, timezone, format) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "convert_time",
    {
      description: "Convert a time from one IANA timezone to another. Times without an explicit offset are read as wall time in fromTimezone.",
      inputSchema: {
        time: z.string().describe('ISO 8601 ("2025-01-15T12:00" or with offset) or unix seconds.'),
        fromTimezone: z.string().describe('IANA timezone the input belongs to when it has no offset, e.g. "UTC".'),
        toTimezone: z.string().describe('Target IANA timezone, e.g. "America/Argentina/Buenos_Aires".'),
        format: z.enum(FORMATS).optional().describe("Output format. Default: iso."),
      },
    },
    async ({ time, fromTimezone, toTimezone, format = "iso" }) => {
      try {
        const date = parseTime(time, fromTimezone);
        return ok({ from: { timezone: fromTimezone, value: formatInZone(date, fromTimezone, "iso") }, to: { timezone: toTimezone, format, value: formatInZone(date, toTimezone, format) } });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_session_log",
    {
      description: "Read the bridge message log: every chat message with the exact date and time it was sent. Defaults to the current client's session log.",
      inputSchema: {
        sessionFile: z.string().optional().describe("Log file name inside logs/ (e.g. from a previous session). Omit for the current session."),
        limit: z.number().int().min(1).max(500).optional().describe("Max entries to return, newest last. Default: 20."),
      },
    },
    async ({ sessionFile, limit = 20 }) => {
      try {
        return ok(await readSessionLog({ sessionFile, limit, contextLog: requestContext.getStore()?.logFile }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

// HTTP entry used by the bridge: carries X-Log-File into the tool handlers.
const statelessHandler = createStatelessHandler(buildTimeServer);
export function handleTimeHttp(req, res, parsedBody) {
  return requestContext.run({ logFile: req.headers["x-log-file"] }, () => statelessHandler(req, res, parsedBody));
}

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
    serveHttp(handleTimeHttp, port);
    console.error(`[pirpc-time] streamable HTTP (stateless) on http://localhost:${port}/ — POST only`);
    return;
  }
  const server = buildTimeServer();
  await server.connect(new StdioServerTransport());
}

if (isMain()) {
  // Surface unexpected failures on stderr without breaking protocol framing.
  process.on("uncaughtException", (err) => {
    try { appendFileSync(join(LOG_DIR, "mcp-time-errors.log"), `${new Date().toISOString()} ${err.stack}\n`); } catch {}
    process.exit(1);
  });
  await main();
}
