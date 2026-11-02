// Structured log (PiersAG/app-business-core#503, #796, #806; Matt Murphy #207,
// #319, #243).
//
// ONE LINE PER EVENT, ONE SHAPE. Every line carries the time, a level from one
// fixed scale (debug < info < warn < error), the event name and — inside a
// request — the request id, route, method, user and tenant. A request's own
// line (lib/observability/with-request-log.ts) adds its status and duration.
// Bodies and headers are never fields: callers pass named values, and only
// strings, numbers, booleans and null are kept, so an object cannot smuggle a
// body or a header set in. A field whose NAME says it holds a secret (password,
// token, key, cookie, authorization …) is dropped too.
//
// ONE SWAPPABLE "SEND THE LOGS" STEP. Every line goes to the platform log
// (stdout) and to ONE sink chosen by LOG_SINK:
//   * "durable" (default) — the app's own database, the same place as the
//     durable error log (lib/observability/error-log.ts), table `log_events`.
//     Costs nothing and needs no outside account.
//   * "console" — the platform log only.
// An outside error-tracking or log service (decision #700, the CEO's) plugs in
// as one more sink: `registerLogSink({ name, send })` in one file, then
// LOG_SINK=<name>. Nothing else changes.
//
// NEVER THROWS, NEVER DELAYS THE ANSWER. A sink write runs after the response
// (Next.js `after`), and a failed write is reported once on stderr and dropped.

import "server-only";

import { after } from "next/server";
import { currentRequest } from "@/lib/observability/request-context";
import { sinkClient } from "@/lib/observability/error-log";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogValue = string | number | boolean | null;

export interface LogInput {
  level: LogLevel;
  /** What happened, e.g. "request", "audit.plan_changed", "cross_tenant_access". */
  event: string;
  requestId?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  durationMs?: number | null;
  userId?: string | null;
  tenantId?: string | null;
  /** What the caller was doing, e.g. "settings.update". */
  action?: string | null;
  fields?: Record<string, unknown>;
}

export interface LogRecord {
  at: string;
  level: LogLevel;
  event: string;
  request_id: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  duration_ms: number | null;
  user_id: string | null;
  tenant_id: string | null;
  action: string | null;
  fields: Record<string, LogValue>;
}

/** Where log records are sent. One is chosen per process (LOG_SINK). */
export interface LogSink {
  readonly name: string;
  send(record: LogRecord): Promise<void>;
}

// A field named for a secret is dropped whatever its value (ASVS V7.1.1).
const SECRET_FIELD =
  /(password|passwd|passphrase|secret|token|api_?key|private_?key|access_?key|authorization|credential|cookie|jwt|bearer|session_?id|database_?url|dsn)/i;
const MAX_TEXT = 500;

function clip(v: string | null | undefined): string | null {
  return v == null ? null : String(v).slice(0, MAX_TEXT);
}

/** Is `level` at or above `min` on the fixed scale? */
export function levelAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}

/** The lowest level written (LOG_LEVEL; default info). An unknown value means info. */
export function minLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "info";
}

/** Build the record for an event: request context filled in, unsafe fields dropped. */
export function toRecord(input: LogInput, now: Date = new Date()): LogRecord {
  const ctx = currentRequest();
  const fields: Record<string, LogValue> = {};
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    if (SECRET_FIELD.test(name)) continue;
    if (value === null || typeof value === "boolean") fields[name] = value;
    else if (typeof value === "number") fields[name] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") fields[name] = value.slice(0, MAX_TEXT);
  }
  return {
    at: now.toISOString(),
    level: input.level,
    event: clip(input.event) ?? "event",
    request_id: clip(input.requestId ?? ctx?.requestId),
    route: clip(input.route ?? ctx?.route),
    method: clip(input.method ?? ctx?.method),
    status: input.status ?? null,
    duration_ms: input.durationMs == null ? null : Math.round(input.durationMs),
    user_id: clip(input.userId ?? ctx?.userId),
    tenant_id: clip(input.tenantId ?? ctx?.tenantId),
    action: clip(input.action),
    fields,
  };
}

/** The platform-log line for a record — exported so tests read the exact shape. */
export function logLine(record: LogRecord): string {
  return JSON.stringify({ log_event: record.event, ...record });
}

// ── Sinks ────────────────────────────────────────────────────────────────────

export const consoleSink: LogSink = {
  name: "console",
  async send() {
    // The platform-log line is written for every record already (logEvent).
  },
};

const ENSURE_SQL = `CREATE TABLE IF NOT EXISTS log_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  request_id TEXT,
  route TEXT,
  method TEXT,
  status INTEGER,
  duration_ms INTEGER,
  user_id TEXT,
  tenant_id TEXT,
  action TEXT,
  fields TEXT
);`;

let ensured = false;

async function ensureLogTable(client: NonNullable<ReturnType<typeof sinkClient>>): Promise<void> {
  if (ensured) return;
  await client.execute(ENSURE_SQL);
  await client.execute("CREATE INDEX IF NOT EXISTS log_events_occurred_idx ON log_events(occurred_at);");
  await client.execute("CREATE INDEX IF NOT EXISTS log_events_request_idx ON log_events(request_id);");
  ensured = true;
}

/** The default sink: the app's own database, beside the durable error log. */
export const durableSink: LogSink = {
  name: "durable",
  async send(record) {
    const client = sinkClient();
    if (!client) return; // no database configured: the platform-log line is the record
    await ensureLogTable(client);
    await client.execute({
      sql:
        "INSERT INTO log_events (id, occurred_at, level, event, request_id, route, method, status, " +
        "duration_ms, user_id, tenant_id, action, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        globalThis.crypto.randomUUID(),
        Math.floor(Date.parse(record.at) / 1000),
        record.level,
        record.event,
        record.request_id,
        record.route,
        record.method,
        record.status,
        record.duration_ms,
        record.user_id,
        record.tenant_id,
        record.action,
        JSON.stringify(record.fields),
      ],
    });
  },
};

const sinks = new Map<string, LogSink>([
  [durableSink.name, durableSink],
  [consoleSink.name, consoleSink],
]);

/** Add a sink (an outside log or error-tracking service). Chosen with LOG_SINK=<name>. */
export function registerLogSink(sink: LogSink): void {
  sinks.set(sink.name, sink);
}

/** The sink LOG_SINK names; "durable" when unset or unknown (never silently nothing). */
export function selectSink(env: NodeJS.ProcessEnv = process.env): LogSink {
  const name = (env.LOG_SINK ?? "").trim().toLowerCase() || durableSink.name;
  return sinks.get(name) ?? durableSink;
}

// ── Writing ──────────────────────────────────────────────────────────────────

const pending = new Set<Promise<void>>();
let reportedFailure = false;

function schedule(work: () => Promise<void>): void {
  const p = work()
    .catch((e) => {
      if (!reportedFailure) {
        reportedFailure = true;
        console.error("[log] the log sink could not write a record", e instanceof Error ? e.message : e);
      }
    })
    .finally(() => pending.delete(p));
  pending.add(p);
  try {
    after(() => p); // keep the serverless function alive until the write ends
  } catch {
    // Not inside a request (a script, a test): the promise runs on its own.
  }
}

/** Write one event: the platform-log line now, the sink after the response. Never throws. */
export function logEvent(input: LogInput, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!levelAtLeast(input.level, minLevel(env))) return;
    const record = toRecord(input);
    const line = logLine(record);
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else console.log(line);
    const sink = selectSink(env);
    if (sink !== consoleSink) schedule(() => sink.send(record));
  } catch {
    // Logging must never turn a request into an error.
  }
}

/** Wait for every sink write started so far (tests, scripts). */
export async function flushLogs(): Promise<void> {
  await Promise.all([...pending]);
}

/** Requests slower than `thresholdMs` in the durable log since `sinceEpochMs`. May throw. */
export async function slowRequestCountSince(
  sinceEpochMs: number,
  thresholdMs: number,
): Promise<number> {
  const client = sinkClient();
  if (!client) return 0;
  await ensureLogTable(client);
  const res = await client.execute({
    sql:
      "SELECT COUNT(*) AS n FROM log_events WHERE event = 'request' AND occurred_at >= ? AND duration_ms >= ?",
    args: [Math.floor(sinceEpochMs / 1000), thresholdMs],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? Number(row.n ?? 0) : 0;
}

/** The slow-request threshold in milliseconds (SLOW_REQUEST_MS; default 1000). */
export function slowRequestMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SLOW_REQUEST_MS);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Test hook. */
export function __resetLogForTests(): void {
  ensured = false;
  reportedFailure = false;
  sinks.clear();
  sinks.set(durableSink.name, durableSink);
  sinks.set(consoleSink.name, consoleSink);
}
