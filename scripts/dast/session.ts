// The signed-in half of the active scan (app-business-core issue 533; Matt
// Murphy #223: "ZAP should crawl every page, test every form and probe every API
// endpoint for injection before the first user").
//
//   npx tsx scripts/dast/session.ts --base http://127.0.0.1:3000 --out dast-results/session.json
//
// Against the LOCALLY SERVED app only (it refuses any other address): creates a
// throwaway test account through the app's own sign-up endpoint, signs it in
// through the public credentials endpoint (the one the login form posts to),
// and writes what a signed-in browser would send — the session cookie and the
// request token every write needs (lib/csrf.ts) — for ZAP to add to every
// request. The values are made with the scan's throwaway session secret and
// reach nothing real. Exit 0 = signed in, and a signed-in page answered 200.

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "../server-only-node.cjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decode } from "@auth/core/jwt";
import { CSRF_HEADER, csrfTokenFor } from "@/lib/csrf";

export const SESSION_COOKIE = "authjs.session-token";
/** RFC 5737 documentation address: the scan's own sign-in budget (lib/auth-rate-limit.ts). */
export const SCAN_ADDRESS = "203.0.113.233";
export const SCAN_EMAIL = "active-scan@example.invalid";
export const SCAN_PASSWORD = "active scan throwaway passphrase";
/** A page only a signed-in account can open: proves the session works. */
export const SIGNED_IN_PROBE = "/dashboard";

/** The machine itself, by the names a scan may use for it. */
export const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];
/** Docker Desktop's name for the machine running the container (a local run of ZAP). */
export const DOCKER_HOST = "host.docker.internal";

/** Loopback only: the scan attacks what it is pointed at. */
export function assertLocalTarget(base: string, options: { dockerHost?: boolean } = {}): URL {
  const url = new URL(base);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = options.dockerHost ? [...LOCAL_HOSTS, DOCKER_HOST] : LOCAL_HOSTS;
  if (!allowed.includes(host) || url.protocol !== "http:") {
    throw new Error(
      `The active scan runs against the locally served app only (http://127.0.0.1 or http://localhost), never ${base}.`,
    );
  }
  return url;
}

/** The session cookie's value from a Set-Cookie list, or null. */
export function sessionFromSetCookie(setCookies: string[]): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * A Cookie header from a Set-Cookie list, as a browser keeps it: a name set
 * twice keeps its LAST value (Auth.js sets its token cookie once per origin it
 * knows, and reads only one back).
 */
export function cookieHeader(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export type ScanSession ={ cookie: string; csrfHeader: string; csrfToken: string; email: string };

export async function signInForScan(base: string, secret: string): Promise<ScanSession> {
  const url = assertLocalTarget(base);
  const root = url.origin;
  const headers = { "x-forwarded-for": SCAN_ADDRESS };

  const signup = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ email: SCAN_EMAIL, password: SCAN_PASSWORD }),
  });
  if (signup.status !== 201 && signup.status !== 409) {
    throw new Error(`sign-up answered ${signup.status}: ${await signup.text()}`);
  }

  const csrfRes = await fetch(`${root}/api/auth/csrf`, { headers });
  const csrfCookie = cookieHeader(csrfRes.headers.getSetCookie());
  const { csrfToken: formToken } = (await csrfRes.json()) as { csrfToken: string };

  const signin = await fetch(`${root}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: formToken,
      email: SCAN_EMAIL,
      password: SCAN_PASSWORD,
      callbackUrl: SIGNED_IN_PROBE,
    }),
  });
  const cookie = sessionFromSetCookie(signin.headers.getSetCookie());
  if (!cookie) throw new Error(`sign-in set no session cookie (HTTP ${signin.status})`);

  const claims = await decode({ token: cookie, secret, salt: SESSION_COOKIE });
  const token = csrfTokenFor(
    { user: { id: (claims?.id ?? claims?.sub) as string, sessionId: claims?.sessionId as string } },
    { AUTH_SECRET: secret },
  );
  if (!token) throw new Error("the session carries no user id or session id, so it has no request token");

  const probe = await fetch(`${root}${SIGNED_IN_PROBE}`, {
    redirect: "manual",
    headers: { ...headers, cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  if (probe.status !== 200) {
    throw new Error(`${SIGNED_IN_PROBE} answered ${probe.status} with the new session: the scan would run signed out`);
  }
  return { cookie, csrfHeader: CSRF_HEADER, csrfToken: token, email: SCAN_EMAIL };
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set: start the app and this script with the scan's throwaway values");
  const out = arg("--out", "dast-results/session.json");
  const session = await signInForScan(arg("--base", "http://127.0.0.1:3000"), secret);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  console.log(`Signed in as ${session.email}; ${SIGNED_IN_PROBE} answered 200. Session written to ${out}.`);
}

if (process.argv[1]?.endsWith("session.ts")) {
  main().catch((error: unknown) => {
    console.error(`::error::Active scan sign-in: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
