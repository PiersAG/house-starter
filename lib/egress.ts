// Outbound network access by need (PiersAG/app-business-core#756; Matt Murphy
// #13: "services without an internet requirement should have no outbound
// access"; #95: "network egress controls").
//
// The hosting platform (Vercel serverless) offers no outbound firewall on the
// plans the factory uses, so the app enforces its own. At server start
// (instrumentation.ts) every TCP connection this process opens — fetch, the
// Stripe and Resend clients, the database client, any package in the dependency
// tree — is checked against ./egress-allow.json plus the addresses the
// environment names (the app's own, its databases, its rate-limit store,
// EGRESS_ALLOW). Any other host is refused: the connection fails with a plain
// error naming the host, and the refusal is logged. This also stops a
// compromised package sending stolen keys anywhere (Matt Murphy #67).
//
// EGRESS_POLICY:
//   enforce — refuse (the default on a deployed instance, VERCEL_ENV set);
//   report  — allow, but log every host that enforce would refuse;
//   off     — no check (the default locally and in CI).
//
// Limits, recorded rather than hidden: a check inside the process stops what
// runs inside the process; it does not stop a connection made by another
// process. Serverless functions start no other process.
//
// Node.js runtime only. Never imported by auth.config.ts or the Edge middleware.

import net from "node:net";
import allowFile from "./egress-allow.json";

export type EgressPolicy = "enforce" | "report" | "off";

export class EgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(
      `Outbound connection to ${host} refused: it is not in lib/egress-allow.json ` +
        "(add it there with the reason, or name it in EGRESS_ALLOW).",
    );
    this.name = "EgressBlockedError";
    this.host = host;
  }
}

/** The policy this environment uses. */
export function egressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const raw = (env.EGRESS_POLICY ?? "").trim().toLowerCase();
  if (raw === "enforce" || raw === "report" || raw === "off") return raw;
  if (raw) {
    throw new Error(
      `lib/egress.ts: EGRESS_POLICY must be enforce, report or off (got ${JSON.stringify(raw)}).`,
    );
  }
  return (env.VERCEL_ENV ?? "").trim() ? "enforce" : "off";
}

function hostOf(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

/** Every allowed host and suffix for this environment. */
export function allowList(env: NodeJS.ProcessEnv = process.env): {
  hosts: Set<string>;
  suffixes: string[];
} {
  const hosts = new Set(Object.keys(allowFile.hosts).map((h) => h.toLowerCase()));
  for (const name of [
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "APP_URL",
    "NEXT_PUBLIC_APP_URL",
    "DATABASE_URL",
    "CATALOG_DATABASE_URL",
    "RATE_LIMIT_STORE_URL",
  ]) {
    const h = hostOf(env[name]);
    if (h) hosts.add(h);
  }
  for (const extra of (env.EGRESS_ALLOW ?? "").split(",")) {
    const h = hostOf(extra);
    if (h) hosts.add(h);
  }
  return { hosts, suffixes: Object.keys(allowFile.suffixes).map((s) => s.toLowerCase()) };
}

/** True when `host` may be reached. */
export function isAllowed(
  host: string,
  list: { hosts: Set<string>; suffixes: string[] },
): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (list.hosts.has(h)) return true;
  return list.suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

// The host a Socket#connect call is for, or null for a local socket (a path).
function connectHost(args: unknown[]): string | null {
  let first = args[0];
  // net.connect() hands Socket#connect its arguments already normalised, as an
  // array [options, callback].
  if (Array.isArray(first)) first = first[0];
  if (typeof first === "string") return null; // IPC path
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  // Socket#connect accepts nothing else: an options object.
  const o = Object(first) as { path?: unknown; host?: unknown };
  if (typeof o.path === "string") return null;
  return typeof o.host === "string" && o.host ? o.host : "localhost";
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
const g = globalThis as unknown as { __egressOriginalConnect?: Connect };

/**
 * Install the check on every TCP connection this process opens. Idempotent.
 * Returns the policy in force.
 */
export function installEgressGuard(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.warn(line),
): EgressPolicy {
  const policy = egressPolicy(env);
  const proto = net.Socket.prototype as unknown as { connect: Connect };
  const original = g.__egressOriginalConnect ?? (g.__egressOriginalConnect = proto.connect);
  if (policy === "off") {
    proto.connect = original;
    return policy;
  }
  const list = allowList(env);
  const reported = new Set<string>();
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const host = connectHost(args);
    if (host === null || isAllowed(host, list)) return original.apply(this, args);
    if (policy === "report") {
      if (!reported.has(host)) {
        reported.add(host);
        log(`[egress] would refuse ${host} (EGRESS_POLICY=report)`);
      }
      return original.apply(this, args);
    }
    log(`[egress] refused ${host}`);
    const err = new EgressBlockedError(host);
    process.nextTick(() => this.destroy(err));
    return this;
  };
  return policy;
}

/** Test hook: put the original connect back. */
export function __uninstallEgressGuardForTests(): void {
  if (g.__egressOriginalConnect) {
    (net.Socket.prototype as unknown as { connect: Connect }).connect =
      g.__egressOriginalConnect;
  }
}
