// @vitest-environment node
//
// The edge firewall rule set and its one switch (app-business-core #511, #754,
// #755): every rule blocks its attack payloads and lets ordinary traffic pass;
// the provider switch is tested in every state.

import { describe, expect, it } from "vitest";
import payloads from "@/config/edge-check-payloads.json";
import {
  EDGE_AUTH_RATE_LIMITS,
  EDGE_BOT_PROTECTED_PATHS,
  EDGE_FIREWALL_PROVIDER,
  EDGE_RULES,
  matchEdgeRule,
  originLockRefuses,
  type EdgeProvider,
} from "@/config/edge-firewall";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";

const req = (path: string, query = "", userAgent = "Mozilla/5.0 (Macintosh) Safari/605.1.15") => ({ path, query, userAgent });

// #511 acceptance: "SQLi/path-traversal payloads to the production URL are blocked
// at the edge; normal traffic passes". The same list scripts/edge-check.mjs sends.
const ATTACKS = payloads.attacks.map((a) => [a.rule, { path: a.path, query: a.query, userAgent: a.userAgent }] as const);
const NORMAL = payloads.normal.map((n) => ({ path: n.path, query: n.query, userAgent: n.userAgent }));

describe("the rule set (#511: SQLi, XSS, path traversal, bad bots)", () => {
  it.each(ATTACKS)("%s blocks %j", (rule, r) => {
    expect(matchEdgeRule(r)?.id).toBe(rule);
  });

  it.each(NORMAL)("normal traffic passes: %j", (r) => {
    expect(matchEdgeRule(r)).toBeNull();
  });

  it("covers every class the ticket names, each with a deny action", () => {
    const ids = EDGE_RULES.map((r) => r.id);
    for (const id of ["sqli", "xss", "path-traversal", "bad-bots"]) expect(ids).toContain(id);
    expect(EDGE_RULES.every((r) => r.action === "deny")).toBe(true);
  });

  it("a malformed escape is matched as written, never thrown", () => {
    expect(() => matchEdgeRule(req("/x", "q=%E0%A4%A"))).not.toThrow();
  });
});

describe("edge rate limits and bot management (#754)", () => {
  it("'login registration and password reset endpoints' all have an edge limit", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password", "/api/auth/"]) {
      expect(EDGE_AUTH_RATE_LIMITS.paths).toContain(p);
    }
  });

  it("'block or challenge any IP exceeding thresholds': challenge first, block above", () => {
    expect(EDGE_AUTH_RATE_LIMITS.windowSeconds).toBe(60);
    expect(EDGE_AUTH_RATE_LIMITS.challengeAbove).toBeLessThan(EDGE_AUTH_RATE_LIMITS.denyAbove);
  });

  it("the edge acts only on a flood: its thresholds sit above the app's own sign-in limits", () => {
    const perMinute = Math.max(AUTH_RATE_LIMITS.login.limit, AUTH_RATE_LIMITS.signup.limit, AUTH_RATE_LIMITS.forgotPassword.limit);
    expect(EDGE_AUTH_RATE_LIMITS.challengeAbove).toBeGreaterThan(perMinute);
  });

  it("'bot management rules that protect high value routes'", () => {
    for (const p of ["/signup", "/login", "/pricing", "/api/billing/checkout"]) expect(EDGE_BOT_PROTECTED_PATHS).toContain(p);
  });
});

describe("the provider switch, every state (#702 → #511, #755)", () => {
  it("ships as 'none' until the CEO decides #702", () => {
    expect(EDGE_FIREWALL_PROVIDER).toBe("none");
  });

  it.each<EdgeProvider>(["none", "vercel"])("%s: nothing in front of the host, so no origin lock", (p) => {
    expect(originLockRefuses(p, null, undefined)).toBe(false);
    expect(originLockRefuses(p, "anything", "secret")).toBe(false);
  });

  it("cloudflare: a request that skipped the proxy is refused; one through it passes (#755)", () => {
    expect(originLockRefuses("cloudflare", null, "s3cret-value")).toBe(true);
    expect(originLockRefuses("cloudflare", "wrong-value!", "s3cret-value")).toBe(true);
    expect(originLockRefuses("cloudflare", "s3cret-valu", "s3cret-value")).toBe(true);
    expect(originLockRefuses("cloudflare", "s3cret-value", "s3cret-value")).toBe(false);
  });

  it("cloudflare with no shared value configured fails closed", () => {
    expect(originLockRefuses("cloudflare", "x", undefined)).toBe(true);
  });
});

describe("scripts/edge-check.mjs — the acceptance check run against production", () => {
  // A stand-in edge: refuses what the rule set matches, serves the rest.
  const edge = async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = new URL(url);
    const hit = matchEdgeRule({ path: u.pathname, query: u.search.slice(1), userAgent: init?.headers?.["user-agent"] ?? "" });
    return new Response(null, { status: hit ? 403 : 200 });
  };
  const open = async () => new Response(null, { status: 200 });

  it("passes when the edge blocks every attack and serves ordinary traffic", async () => {
    const { edgeCheck } = await import("../../scripts/edge-check.mjs");
    expect(await edgeCheck("https://app.example", { fetchImpl: edge, print: () => {} })).toBe(0);
  });

  it("fails, attack by attack, when nothing sits in front", async () => {
    const { edgeCheck } = await import("../../scripts/edge-check.mjs");
    expect(await edgeCheck("https://app.example", { fetchImpl: open, print: () => {} })).toBe(payloads.attacks.length);
  });

  it("with --direct, fails when the host's own address still serves (#755)", async () => {
    const { edgeCheck } = await import("../../scripts/edge-check.mjs");
    expect(await edgeCheck("https://app.example", { direct: "https://app.vercel.app", fetchImpl: edge, print: () => {} })).toBe(1);
  });
});
