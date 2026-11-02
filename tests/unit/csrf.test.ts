// @vitest-environment node
//
// Request-verification tokens on every state-changing endpoint
// (app-business-core issue 353 SEC.12 leg b; Matt Murphy #68: "SameSite
// cookies + request-verification tokens on every state-changing endpoint").
//
//   1. lib/csrf.ts: the token is bound to the user and the session, a forged,
//      missing or other-session token is refused, and a browser request from
//      another website is refused before the token is even read.
//   2. THE ENDPOINT LIST: every API route exporting POST, PUT, PATCH or DELETE
//      is found from the source; each must call verifyCsrf / verifySameOrigin
//      (or go through the MFA guard, which calls verifyCsrf), or be named below
//      with the reason it needs neither.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER, crossOrigin, csrfTokenFor, verifyCsrf, verifySameOrigin } from "@/lib/csrf";
import { EXEMPT, PENDING } from "./csrf-routes";

const ENV = { AUTH_SECRET: "csrf-test-secret-not-used-anywhere-real", APP_CANONICAL_URL: "https://app.example.com" };
const SESSION = { user: { id: "user-a", sessionId: "session-1" } };

function req(headers: Record<string, string> = {}, url = "https://app.example.com/api/settings/x"): Request {
  return new Request(url, { method: "PUT", headers });
}

describe("lib/csrf.ts", () => {
  const token = csrfTokenFor(SESSION, ENV)!;

  it("makes a token bound to the user and the session", () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(SESSION, ENV)).toBe(token);
    expect(csrfTokenFor({ user: { id: "user-b", sessionId: "session-1" } }, ENV)).not.toBe(token);
    expect(csrfTokenFor({ user: { id: "user-a", sessionId: "session-2" } }, ENV)).not.toBe(token);
    expect(csrfTokenFor(SESSION, { ...ENV, AUTH_SECRET: "another-secret" })).not.toBe(token);
    expect(csrfTokenFor(SESSION, { NEXTAUTH_SECRET: ENV.AUTH_SECRET })).toBe(token);
  });

  it("makes none without a signed-in session, and refuses to run without the secret", () => {
    expect(csrfTokenFor(null, ENV)).toBeNull();
    expect(csrfTokenFor({ user: { id: "user-a" } }, ENV)).toBeNull();
    expect(csrfTokenFor({ user: { sessionId: "s" } }, ENV)).toBeNull();
    expect(() => csrfTokenFor(SESSION, {})).toThrow(/AUTH_SECRET is not set/);
  });

  it("accepts this session's token from the app's own origin", () => {
    expect(verifyCsrf(req({ [CSRF_HEADER]: token }), SESSION, ENV)).toBeNull();
    expect(verifyCsrf(req({ [CSRF_HEADER]: token, origin: "https://app.example.com", "sec-fetch-site": "same-origin" }), SESSION, ENV)).toBeNull();
  });

  it("refuses a missing, wrong, other-session or wrong-length token", async () => {
    const other = csrfTokenFor({ user: { id: "user-a", sessionId: "session-2" } }, ENV)!;
    for (const given of [undefined, "", "x", other, token.slice(1), `${token}x`]) {
      const res = verifyCsrf(req(given === undefined ? {} : { [CSRF_HEADER]: given }), SESSION, ENV);
      expect(res?.status, String(given)).toBe(403);
      expect(res?.headers.get("cache-control")).toBe("no-store");
      expect(await res!.json()).toEqual({ error: "This request could not be verified. Reload the page and try again." });
    }
    expect(verifyCsrf(req({ [CSRF_HEADER]: token }), null, ENV)?.status).toBe(403);
  });

  it("refuses another website before the token is read", () => {
    expect(verifyCsrf(req({ [CSRF_HEADER]: token, origin: "https://evil.example" }), SESSION, ENV)?.status).toBe(403);
    expect(verifyCsrf(req({ [CSRF_HEADER]: token, "sec-fetch-site": "cross-site" }), SESSION, ENV)?.status).toBe(403);
    expect(verifyCsrf(req({ [CSRF_HEADER]: token, "sec-fetch-site": "same-site" }), SESSION, ENV)?.status).toBe(403);
  });

  it("tells a browser's cross-site request from a same-origin one and a non-browser one", () => {
    expect(crossOrigin(req({}), ENV)).toBe(false);
    expect(crossOrigin(req({ "sec-fetch-site": "none" }), ENV)).toBe(false);
    expect(crossOrigin(req({ origin: "https://app.example.com" }), ENV)).toBe(false);
    expect(crossOrigin(req({ origin: "null" }), ENV)).toBe(true);
    expect(crossOrigin(req({ origin: "https://app.example.com.evil.example" }), ENV)).toBe(true);
    // Local development: no APP_URL, the request's own origin is the app's.
    expect(crossOrigin(req({ origin: "http://localhost:3000" }, "http://localhost:3000/api/x"), {})).toBe(false);
    expect(crossOrigin(req({ origin: "http://localhost:4000" }, "http://localhost:3000/api/x"), {})).toBe(true);
    // A preview address: the browser's Origin is the address it is on.
    expect(crossOrigin(req({ origin: "https://app-git-x.vercel.app" }, "https://app-git-x.vercel.app/api/x"), ENV)).toBe(false);
    expect(crossOrigin(req({ origin: "https://app-git-x.vercel.app" }), ENV)).toBe(true);
  });

  it("guards signed-out endpoints by origin alone", () => {
    expect(verifySameOrigin(req({}), ENV)).toBeNull();
    expect(verifySameOrigin(req({ origin: "https://evil.example" }), ENV)?.status).toBe(403);
    expect(verifySameOrigin(req({}), undefined as never)).toBeNull();
  });
});

// ── Every write endpoint carries the check ────────────────────────────────────

const ROOT = join(__dirname, "..", "..");

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...routes(rel));
    else if (name === "route.ts") out.push(rel);
  }
  return out;
}

const CHECKED = /\b(verifyCsrf|verifySameOrigin|guardMfaRequest)\s*\(/;

describe("every state-changing endpoint is checked (#353)", () => {
  const writes = routes("app/api").filter((f) =>
    /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+\{[^}]*\b(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/.test(
      readFileSync(join(ROOT, f), "utf8"),
    ),
  );

  it("finds the write endpoints", () => {
    expect(writes).toEqual(expect.arrayContaining(["app/api/settings/[key]/route.ts", "app/api/auth/mfa/enroll/route.ts"]));
  });

  it("checks each one, or names why not", () => {
    const unchecked = writes.filter((f) => !CHECKED.test(readFileSync(join(ROOT, f), "utf8")) && !EXEMPT[f] && !PENDING[f]);
    expect(unchecked).toEqual([]);
  });

  it("keeps its exempt and pending lists true", () => {
    for (const f of [...Object.keys(EXEMPT), ...Object.keys(PENDING)]) expect(writes, f).toContain(f);
    for (const f of Object.keys(PENDING)) {
      expect(CHECKED.test(readFileSync(join(ROOT, f), "utf8")), `${f} is checked now — drop it from PENDING`).toBe(false);
    }
  });

  it("the MFA guard really runs the token check", () => {
    expect(readFileSync(join(ROOT, "lib/mfa/route-guard.ts"), "utf8")).toMatch(/verifyCsrf\(input\.request, input\.session\)/);
  });
});
