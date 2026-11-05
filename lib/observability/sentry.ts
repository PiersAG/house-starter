// Error tracking: errors to Sentry, with personal data stripped first
// (PiersAG/app-business-core#761, #806; decision #700 — Sentry, free plan, EU
// region). The second destination beside the app's own durable error log and
// structured log, which stay exactly as they are.
//
// WHAT GOES. Four kinds of event, each only while the switch in
// config/error-tracking.ts is on AND SENTRY_DSN is a Sentry EU address
// (lib/observability/sentry-dsn.ts); otherwise every function here returns
// false and sends nothing:
//   * every exception the durable error log records (recordError: server
//     render and route errors, outside-service failures) — "source: server";
//   * every error-level structured log line (logEvent) — "source: log",
//     grouped by its event name;
//   * the cross-customer access alert (lib/tenant/access-log.ts) — its own
//     distinct event: level fatal, tag alert=cross_tenant_access, one fixed
//     group, never sampled or budgeted away;
//   * browser errors, which the page posts to the app's own
//     /api/error-report — "source: browser". The page never talks to Sentry,
//     so the page policy (lib/csp.ts) never names it.
// Sentry groups events into issues by stack trace (or by the fingerprint set
// here), counts the accounts each issue reached from `user.id`, and sends its
// alerts — the "new issue" alert, and the cross-customer rule the CEO adds
// (app-business-core wiki/policies/error-tracking.md).
//
// WHAT NEVER GOES. Personal data and request contents. An event carries: the
// error's type, its message and stack frames after scrubbing (below), the page
// path with ids and the query removed, the method, the request id, the
// release, the environment, the browser's name and major version, and the
// signed-in account's opaque id. Never an email, a name, a cookie, a header, a
// request or response body, an IP address, a query string, or a form's
// contents. The event has no `request`, `extra` or `breadcrumbs` part at all.
//
// SCRUBBING (scrubText). Every free text — message, stack, path, tag — has
// email addresses, bearer and basic credentials, JWTs, `secret=value` pairs,
// long tokens, UUIDs, IP addresses, runs of nine or more digits (phone and card
// numbers), quoted text that looks like a person's words (has a space, an @ or
// four digits), URL query strings and a database error's `params:` list
// replaced before it leaves. Log-line fields go only when the value is a
// number, a boolean or a short code (letters, digits, - _ . :) and the field's
// name is not one that holds personal data.
//
// THE FREE PLAN. config/error-tracking.ts: a day's budget shared by every
// instance (one counter in the shared rate-limit store), a per-instance hourly
// cap, and repeats of the same error sent once per window then only sampled.
// Sentry answering 429 pauses sending until its Retry-After.
//
// NEVER THROWS, NEVER DELAYS THE ANSWER: the send runs after the response
// (Next.js `after`) with a 3-second timeout, and a failure is reported once on
// stderr and dropped.

import "server-only";

import { after } from "next/server";
import { errorTrackingConfig, type ErrorTrackingConfig } from "@/config/error-tracking";
import { errorTrackingTarget, type SentryTarget } from "@/lib/observability/sentry-dsn";
import { currentRequest } from "@/lib/observability/request-context";
import type { LogRecord } from "@/lib/observability/log";
import { getRateLimiter } from "@/lib/rate-limit";
import {
  browserOf,
  opaqueId,
  parseStack,
  safeLogFields,
  scrubPath,
  scrubText,
  tagValue,
  type SentryFrame,
} from "@/lib/observability/sentry-scrub";

export { browserOf, parseStack, safeLogFields, scrubPath, scrubText };

export type SentryLevel = "fatal" | "error" | "warning";
export type ReportSource = "server" | "log" | "browser" | "cross_tenant";


/** The whole of what is sent: nothing outside these fields ever reaches Sentry. */
export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node" | "javascript";
  level: SentryLevel;
  logger: string;
  release?: string;
  environment: string;
  message?: { formatted: string };
  exception?: { values: { type: string; value: string; stacktrace?: { frames: SentryFrame[] } }[] };
  tags: Record<string, string>;
  user?: { id: string };
  fingerprint?: string[];
  contexts?: { browser?: { name: string; version?: string }; runtime?: { name: string; version?: string } };
  sdk: { name: string; version: string };
}

// ── The event ────────────────────────────────────────────────────────────────

export interface ErrorReport {
  source: ReportSource;
  level?: SentryLevel;
  /** For an exception: its type ("TypeError"). Absent: a message event. */
  type?: string | null;
  message: string;
  stack?: string | null;
  route?: string | null;
  method?: string | null;
  requestId?: string | null;
  userId?: string | null;
  /** Extra tags, already safe (short codes and opaque ids). */
  tags?: Record<string, string>;
  fingerprint?: string[];
  browser?: { name: string; version?: string } | null;
}

function eventId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** The exact Sentry event for a report. Pure apart from the id and the clock. */
export function buildEvent(
  report: ErrorReport,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): SentryEvent {
  const tags: Record<string, string> = { source: report.source };
  const add = (k: string, v: string | null | undefined) => {
    const t = tagValue(v);
    if (t) tags[k] = t;
  };
  add("route", scrubPath(report.route));
  add("method", report.method ? report.method.toUpperCase().slice(0, 10) : null);
  for (const [k, v] of Object.entries(report.tags ?? {})) add(k, v);
  // The request id is the app's own random id (a UUID), checked by shape, not scrubbed:
  // it is what finds the same request in the app's own logs.
  if (report.requestId && /^[A-Za-z0-9-]{8,64}$/.test(report.requestId)) tags.request_id = report.requestId;

  const message = scrubText(report.message);
  const event: SentryEvent = {
    event_id: eventId(),
    timestamp: now.getTime() / 1000,
    platform: report.source === "browser" ? "javascript" : "node",
    level: report.level ?? "error",
    logger: report.source,
    environment: (env.VERCEL_ENV ?? "").trim() || "development",
    tags,
    sdk: { name: "house-starter.error-tracking", version: "1" },
  };
  const release = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  if (/^[0-9a-f]{7,40}$/i.test(release)) event.release = release;
  if (report.type) {
    const frames = parseStack(report.stack);
    event.exception = {
      values: [
        {
          type: scrubText(report.type, 100) || "Error",
          value: message,
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    };
  } else {
    event.message = { formatted: message };
  }
  const userId = opaqueId(report.userId);
  if (userId) event.user = { id: userId };
  if (report.fingerprint?.length) event.fingerprint = report.fingerprint.map((f) => scrubText(f, 100));
  if (report.browser) event.contexts = { browser: report.browser };
  else if (report.source !== "browser") {
    event.contexts = { runtime: { name: "node", version: typeof process !== "undefined" ? process.versions?.node : undefined } };
  }
  return event;
}

// ── How much is sent ─────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/** Per-instance limits: the hourly caps, repeats of the same error, a 429 pause. */
export class SendGate {
  private hourStart = 0;
  private sentThisHour = 0;
  private alertsThisHour = 0;
  private lastSent = new Map<string, number>();
  private pausedUntil = 0;

  constructor(
    private readonly config: ErrorTrackingConfig,
    private readonly random: () => number = Math.random,
  ) {}

  private roll(now: number): void {
    if (now - this.hourStart >= HOUR) {
      this.hourStart = now;
      this.sentThisHour = 0;
      this.alertsThisHour = 0;
    }
  }

  /** May an event with this grouping key be sent now? Counts it when yes. */
  allow(key: string, kind: "normal" | "cross_tenant", now: number = Date.now()): boolean {
    if (now < this.pausedUntil) return false;
    this.roll(now);
    if (kind === "cross_tenant") {
      if (this.alertsThisHour >= this.config.maxCrossTenantAlertsPerHour) return false;
      this.alertsThisHour += 1;
      return true;
    }
    if (this.sentThisHour >= this.config.maxEventsPerHour) return false;
    const last = this.lastSent.get(key);
    const windowMs = this.config.dedupeWindowMinutes * 60_000;
    if (last !== undefined && now - last < windowMs && this.random() >= this.config.repeatSampleRate) {
      return false;
    }
    if (last === undefined || now - last >= windowMs) this.lastSent.set(key, now);
    if (this.lastSent.size > 500) {
      for (const [k, t] of this.lastSent) if (now - t >= windowMs) this.lastSent.delete(k);
      if (this.lastSent.size > 500) this.lastSent.clear();
    }
    this.sentThisHour += 1;
    return true;
  }

  /** Sentry said 429: send nothing until then. */
  pause(untilMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
  }
}

/** One counter for the whole app's day, in the shared store. No store: allowed. */
async function underDailyBudget(config: ErrorTrackingConfig): Promise<boolean> {
  let store;
  try {
    store = getRateLimiter();
  } catch {
    return true; // no shared store configured (local, CI): the per-instance caps still hold
  }
  try {
    const n = await store.add("error-tracking:sent", 1, 86_400);
    return n <= config.dailyBudget;
  } catch {
    return true; // a store blip must not lose an error; the per-instance caps still hold
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let transport: FetchLike = (url, init) => fetch(url, init);
let gate = new SendGate(errorTrackingConfig);
let reportedFailure = false;
const pending = new Set<Promise<void>>();

/** The envelope body Sentry's ingest endpoint takes for one event. */
export function envelopeFor(event: SentryEvent, now: Date = new Date()): string {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: now.toISOString() }),
    JSON.stringify({ type: "event", content_type: "application/json" }),
    JSON.stringify(event),
  ].join("\n") + "\n";
}

async function post(target: SentryTarget, event: SentryEvent): Promise<void> {
  const res = await transport(target.envelopeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=house-starter.error-tracking/1`,
    },
    body: envelopeFor(event),
    signal: AbortSignal.timeout(3000),
  });
  if (res.status === 429) {
    const secs = Number(res.headers.get("retry-after") ?? "60");
    gate.pause(Date.now() + (Number.isFinite(secs) && secs > 0 ? secs : 60) * 1000);
  } else if (!res.ok) {
    throw new Error(`Sentry answered ${res.status}`);
  }
}

function schedule(work: () => Promise<void>): void {
  const p = work()
    .catch((e) => {
      if (!reportedFailure) {
        reportedFailure = true;
        console.error("[error-tracking] could not send an event to Sentry", e instanceof Error ? e.message : e);
      }
    })
    .finally(() => pending.delete(p));
  pending.add(p);
  try {
    after(() => p);
  } catch {
    // Not inside a request: the promise runs on its own.
  }
}

/**
 * Send one report, if the switch is on, the DSN is an EU one and the limits
 * allow it. True when it was queued. Never throws.
 */
export function sendReport(
  report: ErrorReport,
  env: NodeJS.ProcessEnv = process.env,
  config: ErrorTrackingConfig = errorTrackingConfig,
): boolean {
  try {
    const target = errorTrackingTarget(env, config);
    if (!target) return false;
    const event = buildEvent(report, env);
    const kind = report.source === "cross_tenant" ? "cross_tenant" : "normal";
    const top = event.exception?.values[0]?.stacktrace?.frames.at(-1);
    const key =
      event.fingerprint?.join("|") ??
      `${report.source}|${event.exception?.values[0]?.type ?? ""}|${(event.exception?.values[0]?.value ?? event.message?.formatted ?? "").slice(0, 200)}|${top?.filename ?? ""}:${top?.lineno ?? ""}`;
    if (!gate.allow(key, kind)) return false;
    schedule(async () => {
      if (kind === "normal" && !(await underDailyBudget(config))) return;
      await post(target, event);
    });
    return true;
  } catch {
    return false;
  }
}

// ── The four kinds of event ──────────────────────────────────────────────────

/** An exception the durable error log recorded (lib/observability/error-log.ts). */
export function reportException(
  input: {
    message: string;
    stack?: string | null;
    route?: string | null;
    method?: string | null;
    requestId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const ctx = currentRequest();
  const stack = originalStack(input.stack ?? null);
  // The type is the first word of a V8 stack ("TypeError: …"); "Error" otherwise.
  const type = /^([A-Za-z_$][\w$]*(?:Error|Exception))\b/.exec(stack ?? "")?.[1] ?? "Error";
  return sendReport(
    {
      source: "server",
      type,
      message: input.message,
      stack,
      route: input.route ?? ctx?.route,
      method: input.method ?? ctx?.method,
      requestId: input.requestId ?? ctx?.requestId,
      userId: ctx?.userId,
    },
    env,
  );
}

// "at fn (/path/file.js:1:2)" or "at /path/file.js:1:2" — a server frame to map.
const SERVER_FRAME = /^(\s*at\s+(?:.*?\s+\()?)(\/[^():]+\.js):(\d+):(\d+)(\)?\s*)$/;

/**
 * The stack with each server frame mapped back to the original file and line
 * ("the exact line of code", #761), using the source maps the build kept
 * (next.config.ts serverSourceMaps) once Node's source-map support is on
 * (instrumentation.ts). A frame with no map is left as it is. Never throws.
 */
export function originalStack(stack: string | null): string | null {
  if (!stack) return stack;
  try {
    // Fetched at call time, not imported: the edge build resolves this module's
    // imports too (through instrumentation.ts), and has no node:module.
    const findSourceMap = process.getBuiltinModule?.("node:module")?.findSourceMap;
    if (!findSourceMap) return stack;
    return stack
      .split("\n")
      .map((line) => {
        const m = SERVER_FRAME.exec(line);
        if (!m) return line;
        const map = findSourceMap(m[2]);
        const origin = map?.findOrigin(Number(m[3]), Number(m[4]));
        if (!origin || !("fileName" in origin) || !origin.fileName) return line;
        const file = origin.fileName.replace(/^webpack:\/\/[^/]*\//, "/");
        return `${m[1]}${file}:${origin.lineNumber}:${origin.columnNumber}${m[5]}`;
      })
      .join("\n");
  } catch {
    return stack;
  }
}

/** Events with their own Sentry event, not forwarded again as a plain log line. */
const DEDICATED_EVENTS = new Set(["cross_tenant_access"]);

/**
 * An error-level structured log line (lib/observability/log.ts). The `request`
 * line of a 500 is not forwarded: the exception behind it already is, through
 * the durable error log, with its stack.
 */
export function reportLogRecord(record: LogRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  if (record.level !== "error") return false;
  if (record.event === "request" || DEDICATED_EVENTS.has(record.event)) return false;
  return sendReport(
    {
      source: "log",
      message: record.event,
      route: record.route,
      method: record.method,
      requestId: record.request_id,
      userId: record.user_id,
      tags: { event: record.event.slice(0, 64), ...safeLogFields(record.fields) },
      fingerprint: ["log", record.event],
    },
    env,
  );
}

/**
 * The cross-customer access alert (#806, Matt Murphy #171): its own Sentry
 * issue, level fatal, tagged so an alert rule can fire on every occurrence. It
 * names the account and the two customers' opaque ids, never their data.
 */
export function reportCrossTenantAccess(
  input: {
    userId: string | null;
    sessionTenantId: string | null;
    dataTenantId: string;
    route?: string | null;
    method?: string | null;
    requestId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const tags: Record<string, string> = { alert: "cross_tenant_access", priority: "high" };
  const data = opaqueId(input.dataTenantId);
  const session = opaqueId(input.sessionTenantId);
  if (data) tags.data_tenant = data;
  if (session) tags.session_tenant = session;
  return sendReport(
    {
      source: "cross_tenant",
      level: "fatal",
      message: "Cross-customer access: a signed-in session opened another customer's database",
      route: input.route,
      method: input.method,
      requestId: input.requestId,
      userId: input.userId,
      tags,
      fingerprint: ["cross-tenant-access"],
    },
    env,
  );
}

/** A browser error relayed by /api/error-report. */
export function reportBrowserError(
  input: {
    type: string;
    message: string;
    stack?: string | null;
    page?: string | null;
    kind: string;
    userId?: string | null;
    userAgent?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // A rage click (issue 736) is a warning about the page, not an exception:
  // one group per control per page.
  if (input.kind === "rage_click") {
    return sendReport(
      {
        source: "browser",
        level: "warning",
        message: input.message,
        route: input.page,
        userId: input.userId,
        tags: { kind: "rage_click" },
        fingerprint: ["rage-click", scrubPath(input.page) ?? "/", input.message.slice(0, 120)],
        browser: browserOf(input.userAgent),
      },
      env,
    );
  }
  return sendReport(
    {
      source: "browser",
      type: input.type || "Error",
      message: input.message,
      stack: input.stack,
      route: input.page,
      userId: input.userId,
      tags: { kind: input.kind },
      browser: browserOf(input.userAgent),
    },
    env,
  );
}

/** Wait for every send started so far (tests, scripts). */
export async function flushErrorTracking(): Promise<void> {
  await Promise.all([...pending]);
}

/** Test hooks. */
export function __setErrorTrackingTransportForTests(fn: FetchLike | null): void {
  transport = fn ?? ((url, init) => fetch(url, init));
}
export function __resetErrorTrackingForTests(config: ErrorTrackingConfig = errorTrackingConfig, random?: () => number): void {
  gate = new SendGate(config, random);
  reportedFailure = false;
}
