#!/usr/bin/env node
// MCP server: current time in any IANA timezone, conversion between timezones,
// and read access to the bridge's per-session message log.
//
// Timezone math uses the built-in Intl API — no dependencies beyond the MCP SDK.
// The session log is written by server.mjs as JSONL; PIRPC_LOG_FILE (inherited
// from the pi process that launched us) points this server at the current
// client's log. Without it, the most recent log file is used.

import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG_DIR = new URL("../logs/", import.meta.url).pathname;
mkdirSync(LOG_DIR, { recursive: true });

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

async function readSessionLog({ sessionFile, limit }) {
  let file;
  if (sessionFile) {
    if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
      throw new Error("sessionFile must be a .jsonl file name inside the logs directory.");
    }
    file = join(LOG_DIR, sessionFile);
  } else if (process.env.PIRPC_LOG_FILE) {
    file = process.env.PIRPC_LOG_FILE;
  } else {
    const names = (await readdir(LOG_DIR).catch(() => [])).filter((n) => n.endsWith(".jsonl"));
    if (names.length === 0) throw new Error("No session logs found yet.");
    file = join(LOG_DIR, names.sort().at(-1)); // timestamped names sort chronologically
  }
  const resolved = resolve(file);
  if (!resolved.startsWith(resolve(LOG_DIR) + sep)) throw new Error("Log path escapes the logs directory.");
  const lines = (await readFile(resolved, "utf8")).split("\n").filter(Boolean);
  const entries = lines.slice(-limit).map((l) => JSON.parse(l));
  return { file: basename(resolved), count: entries.length, entries };
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });

const server = new McpServer({ name: "pirpc-time", version: "0.1.0" });

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
      return ok(await readSessionLog({ sessionFile, limit }));
    } catch (err) {
      return fail(err);
    }
  },
);

// Surface unexpected failures on stderr without breaking stdio protocol framing.
process.on("uncaughtException", (err) => {
  try { appendFileSync(join(LOG_DIR, "mcp-time-errors.log"), `${new Date().toISOString()} ${err.stack}\n`); } catch {}
  process.exit(1);
});

await server.connect(new StdioServerTransport());
