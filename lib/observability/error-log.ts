// Durable in-house runtime error sink (la-a-uptime-monitoring §b).
//
// WHY. Vercel's live-tail log is ephemeral — the checkout-500 incident
// (2026-07-16) left no recoverable log after ~16h, so the defect could not be
// diagnosed from logs at all. This persists structured errors to the app's OWN
// database so records survive past the tail window and can be counted by the
// /api/health readiness endpoint and the external prober.
//
// BUILD-NOT-BUY (settings-registry-spec §7 third-party-assessment rule).
// Applying the four tests to Sentry (SaaS) vs an in-house sink:
//   • marginal cost per tenant — in-house is a table in a DB we already run; ~0.
//   • data location — error payloads can carry PII (request paths, user/session
//     context). In-house keeps them inside the tenant's own DB isolation; Sentry
//     SaaS makes them an external sub-processor needing a DPA + register entry
//     (la-b-subprocessor-dpa).
//   • resale licensing — n/a.
//   • differentiating vs plumbing — a liveness / error-rate signal is plumbing;
//     Sentry's rich UI is not needed for it.
// Conclusion (CEO 2026-07-23): build in-house. A richer tool can layer on later.
//
// NEVER THROWS. Observability must not turn one error into a second error that
// crashes the request. Every failure here is swallowed after a console.error.

import { createClient, type Client } from "@libsql/client";

export interface ErrorEventInput {
  message: string;
  stack?: string | null;
  route?: string | null;
  method?: string | null;
  digest?: string | null;
  context?: Record<string, unknown> | null;
}

// A remote libSQL/Turso URL needs an auth token; a local file:/:memory: URL does
// not (mirrors lib/db.ts / instrumentation.ts).
const REMOTE_DB_SCHEME = /^(libsql|https?|wss?):/i;

let cachedClient: Client | null = null;
let ensured = false;

function normaliseUrl(raw: string): string {
  if (raw === ":memory:") return raw;
  if (/^[a-z]+:/i.test(raw)) return raw;
  return `file:${raw}`;
}

/**
 * The sink's own connection, resolved from DATABASE_URL — present in every
 * deploy (`.env.contract` declares it `generated`), so the sink works in both
 * shared and per-tenant apps without needing tenant context (an error caught in
 * instrumentation.onRequestError has none). Cached process-wide. Returns null
 * only when nothing is configured (pure local dev with no DB), so the caller
 * falls back to structured stderr rather than crashing.
 */
export function sinkClient(env: NodeJS.ProcessEnv = process.env): Client | null {
  if (cachedClient) return cachedClient;
  const url = env.DATABASE_URL;
  if (!url) return null;
  const authToken = REMOTE_DB_SCHEME.test(url) ? env.DATABASE_AUTH_TOKEN : undefined;
  cachedClient = createClient({ url: normaliseUrl(url), authToken });
  return cachedClient;
}

// Self-sufficient DDL. The table is also declared in lib/schema.ts + applied by
// lib/migrate.ts, but per-tenant apps may point DATABASE_URL at a system DB the
// tenant migration loop never touched — so the sink ensures its own table
// exists (idempotent, cheap, once per process) rather than assuming a migration
// reached this connection.
const ENSURE_SQL = `CREATE TABLE IF NOT EXISTS error_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  method TEXT,
  digest TEXT,
  context TEXT
);`;

async function ensureTable(client: Client): Promise<void> {
  if (ensured) return;
  await client.execute(ENSURE_SQL);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS error_events_occurred_idx ON error_events(occurred_at);",
  );
  ensured = true;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `err_${Date.now()}`;
}

/**
 * Persist one structured error. Returns true on a durable write, false when it
 * fell back to stderr (no sink) or the write failed. Never throws.
 */
export async function recordError(
  input: ErrorEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const client = sinkClient(env);
    if (!client) {
      console.error(
        "[app-error] no DATABASE_URL sink — " +
          JSON.stringify({ message: input.message, route: input.route, method: input.method }),
      );
      return false;
    }
    await ensureTable(client);
    await client.execute({
      sql:
        "INSERT INTO error_events (id, message, stack, route, method, digest, context) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        newId(),
        String(input.message).slice(0, 4000),
        input.stack ? String(input.stack).slice(0, 8000) : null,
        input.route ?? null,
        input.method ?? null,
        input.digest ?? null,
        input.context ? JSON.stringify(input.context).slice(0, 4000) : null,
      ],
    });
    return true;
  } catch (err) {
    console.error("[app-error] failed to persist error event", err);
    return false;
  }
}

/**
 * Count error events since `sinceEpochMs`. Used by /api/health as an
 * informational error-rate signal. May throw (the caller treats a throw as
 * "unknown" rather than "healthy").
 */
export async function errorCountSince(
  sinceEpochMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const client = sinkClient(env);
  if (!client) return 0;
  await ensureTable(client);
  const res = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM error_events WHERE occurred_at >= ?",
    args: [Math.floor(sinceEpochMs / 1000)],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? Number(row.n ?? 0) : 0;
}

/** Test hook — drop the cached client + ensured flag between env manipulations. */
export function __resetSinkForTests(): void {
  cachedClient = null;
  ensured = false;
}
