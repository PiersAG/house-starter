// @vitest-environment node
// The signed-in active scan (scripts/dast/*; app-business-core issue 533 —
// "Add an active scan of the locally served app, signed in with a seeded test
// account and covering app/api routes; block on High. Acceptance: a seeded XSS
// flaw behind login is caught; the clean template passes").
//
// The scan itself runs in CI (`active-scan` job, .github/workflows/ci.yml). These
// tests hold its parts: the local-only target, the sign-in, every API route in
// the scan's input, the plan's exclusions and time limits, and the gate —
// including against the real report of a scan of the template with a seeded
// cross-site-scripting flaw behind sign-in (tests/unit/fixtures/).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAllRoutes } from "../isolation/route-map";
import { assertLocalTarget, cookieHeader, DOCKER_HOST, sessionFromSetCookie, SESSION_COOKIE } from "../../scripts/dast/session";
import { ACTIVE_SCAN_MINUTES, automationPlan, bodyFields, extraStarts, openApiFor, ownerSettingKey, SCAN_EXCLUSIONS } from "../../scripts/dast/plan";
import { findings, judge, refusals, summary, type ZapReport } from "../../scripts/dast/gate";

const ROOT = join(__dirname, "..", "..");
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as ZapReport;
const SESSION = { cookie: "c00kie", csrfHeader: "x-csrf-token", csrfToken: "t0ken", email: "active-scan@example.invalid" };

describe("target: the locally served app only", () => {
  it("accepts loopback addresses", () => {
    for (const ok of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"]) {
      expect(assertLocalTarget(ok).protocol).toBe("http:");
    }
  });

  it("refuses anything else, including a deployed app", () => {
    for (const bad of [
      "https://k9coach.example",
      "https://house-starter-preview.vercel.app",
      "http://192.168.1.10:3000",
      "https://127.0.0.1:3000",
      "http://127.0.0.1.evil.example:3000",
    ]) {
      expect(() => assertLocalTarget(bad), bad).toThrow(/locally served app only/);
    }
  });

  it("allows Docker Desktop's name for this machine only where ZAP is pointed, not for sign-in", () => {
    expect(() => assertLocalTarget(`http://${DOCKER_HOST}:3000`)).toThrow();
    expect(assertLocalTarget(`http://${DOCKER_HOST}:3000`, { dockerHost: true }).hostname).toBe(DOCKER_HOST);
  });
});

describe("sign-in: the seeded test account's session", () => {
  it("keeps a cookie's last value, as a browser does", () => {
    expect(cookieHeader(["a=1; Path=/", "b=2; HttpOnly", "a=3; Path=/"])).toBe("a=3; b=2");
  });

  it("finds the session cookie and nothing else", () => {
    expect(sessionFromSetCookie(["authjs.csrf-token=x; Path=/", `${SESSION_COOKIE}=abc.def; HttpOnly`])).toBe("abc.def");
    expect(sessionFromSetCookie(["authjs.csrf-token=x"])).toBeNull();
    expect(sessionFromSetCookie([`${SESSION_COOKIE}=; Max-Age=0`])).toBeNull();
  });
});

describe("the scan's input covers every API route (app/api)", () => {
  const routes = discoverAllRoutes(join(ROOT, "app"));
  const api = openApiFor(routes, "http://127.0.0.1:3000");

  it("has an operation for every verb of every API route, apart from Auth.js's own", () => {
    for (const route of routes.filter((r) => r.kind === "api" && !r.path.startsWith("/api/auth/["))) {
      const path = route.path.replace(/\[\[?(?:\.\.\.)?(\w+)\]?\]/g, "{$1}");
      for (const method of route.methods.filter((m) => m !== "OPTIONS" && m !== "HEAD")) {
        expect(api.paths[path]?.[method.toLowerCase()], `${method} ${route.path}`).toBeDefined();
      }
    }
    expect(Object.keys(api.paths).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(api.paths).some((p) => p.startsWith("/api/auth/{"))).toBe(false);
  });

  it("gives writes an example body from the fields the route validates, so each field is attacked", () => {
    expect(bodyFields('const s = z.object({ email: z.string(), "csp-report": z.record(z.string()), key: settingKeyField })')).toEqual([
      "csp-report",
      "email",
      "key",
    ]);
    const signup = api.paths["/api/auth/signup"]?.post as { requestBody?: { content: Record<string, { schema: { properties: object } }> } };
    expect(signup?.requestBody).toBeDefined();
    expect(Object.keys(signup!.requestBody!.content["application/json"].schema.properties).length).toBeGreaterThan(0);
  });

  it("fills route parameters, with a real owner-writable setting for the settings route", () => {
    const op = api.paths["/api/settings/{key}"];
    expect(op).toBeDefined();
    expect(JSON.stringify(op)).toContain('"in":"path"');
    const key = ownerSettingKey();
    expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
    expect(JSON.stringify(op)).toContain(`"example":"${key}"`);
  });

  it("adds the self-test's seeded page as a crawl start only when asked", () => {
    expect(extraStarts({})).toEqual([]);
    expect(extraStarts({ SCAN_EXTRA_START: "/dashboard/canary?q=hello, //evil.example, nope" })).toEqual(["/dashboard/canary?q=hello"]);
    const plan = automationPlan("http://127.0.0.1:3000", SESSION, "/zap/wrk", ["/dashboard/canary?q=hello"]);
    expect(JSON.stringify(plan.jobs)).toContain("http://127.0.0.1:3000/dashboard/canary?q=hello");
  });
});

describe("the plan", () => {
  const plan = automationPlan("http://127.0.0.1:3000", SESSION, "/zap/wrk");
  const jobs = plan.jobs.map((j) => j.type);

  it("signs every request in: the session cookie and the request token", () => {
    const replacer = plan.jobs.find((j) => j.type === "replacer") as { rules: { matchString: string; replacementString: string }[] };
    const headers = Object.fromEntries(replacer.rules.map((r) => [r.matchString.toLowerCase(), r.replacementString]));
    expect(headers.cookie).toBe(`${SESSION_COOKIE}=c00kie`);
    expect(headers["x-csrf-token"]).toBe("t0ken");
  });

  it("imports the API, crawls the pages, and ACTIVELY scans, within a time limit, then reports", () => {
    expect(jobs.indexOf("replacer")).toBe(0);
    expect(jobs.indexOf("openapi")).toBeLessThan(jobs.indexOf("activeScan"));
    expect(jobs.indexOf("spider")).toBeLessThan(jobs.indexOf("activeScan"));
    const active = plan.jobs.find((j) => j.type === "activeScan") as { parameters: { maxScanDurationInMins: number } };
    expect(active.parameters.maxScanDurationInMins).toBe(ACTIVE_SCAN_MINUTES);
    expect(ACTIVE_SCAN_MINUTES).toBeLessThanOrEqual(30);
    const reports = plan.jobs.filter((j) => j.type === "report") as { parameters: { reportFile: string } }[];
    expect(reports.map((r) => r.parameters.reportFile)).toContain("report.json");
  });

  it("never sends what would end its own session, each with its reason", () => {
    const excluded = plan.env.contexts[0].excludePaths.join("\n");
    for (const path of ["/api/auth/signout", "/api/auth/callback/credentials", "/sessions/revoke"]) {
      expect(SCAN_EXCLUSIONS.some((e) => new RegExp(`^${e.pattern}$`).test(path)), path).toBe(true);
    }
    expect(excluded).toContain("signout");
    for (const e of SCAN_EXCLUSIONS) expect(e.reason.length).toBeGreaterThan(10);
  });

  it("stays on the app it was pointed at", () => {
    expect(plan.env.contexts[0].includePaths).toEqual(["http://127\\.0\\.0\\.1:3000.*"]);
  });
});

describe("the gate: blocks on High, fail-closed", () => {
  const done = "Job activeScan started\nJob activeScan finished, time taken: 00:12:00\n";
  const report = (riskcode: string): ZapReport => ({
    site: [{ "@name": "http://127.0.0.1:3000", alerts: [{ pluginid: "40012", alert: "Cross Site Scripting (Reflected)", riskcode, instances: [{ uri: "http://127.0.0.1:3000/x", method: "GET", param: "q" }] }] }],
  });

  it("passes a scan with no High finding that stayed signed in", () => {
    expect(judge({ report: report("2"), zapLog: done, stillSignedIn: true }).passed).toBe(true);
  });

  it("blocks a High finding", () => {
    const v = judge({ report: report("3"), zapLog: done, stillSignedIn: true });
    expect(v.passed).toBe(false);
    expect(v.problems.join()).toContain("Cross Site Scripting (Reflected)");
  });

  it("fails a missing report, an empty report, an unfinished active scan, and a lost session", () => {
    expect(judge({ report: null, zapLog: done, stillSignedIn: true }).passed).toBe(false);
    expect(judge({ report: { site: [] }, zapLog: done, stillSignedIn: true }).passed).toBe(false);
    expect(judge({ report: report("1"), zapLog: "Job activeScan started\n", stillSignedIn: true }).passed).toBe(false);
    expect(judge({ report: report("1"), zapLog: done, stillSignedIn: false }).problems.join()).toMatch(/signed out/);
  });

  it("catches the seeded cross-site-scripting flaw behind sign-in (real scan report)", () => {
    const seeded = fixture("zap-active-seeded-xss.json");
    const v = judge({ report: seeded, zapLog: done, stillSignedIn: true });
    expect(v.passed).toBe(false);
    const high = findings(seeded).filter((f) => f.risk === 3);
    expect(high.some((f) => /Cross Site Scripting/i.test(f.name) && f.where.includes("/dashboard/"))).toBe(true);
  });

  it("passes the clean template (real scan report)", () => {
    const clean = fixture("zap-active-clean.json");
    expect(judge({ report: clean, zapLog: done, stillSignedIn: true }).passed).toBe(true);
  });

  it("passes the seeded report in self-test mode only when the flaw is at the seeded page", () => {
    const seeded = fixture("zap-active-seeded-xss.json");
    expect(judge({ report: seeded, zapLog: done, stillSignedIn: true, expectHigh: "/dashboard/canary" }).passed).toBe(true);
    expect(judge({ report: fixture("zap-active-clean.json"), zapLog: done, stillSignedIn: true, expectHigh: "/dashboard/canary" }).passed).toBe(false);
    expect(judge({ report: seeded, zapLog: done, stillSignedIn: false, expectHigh: "/dashboard/canary" }).passed).toBe(false);
  });

  it("counts what the app's own defences refused", () => {
    const log = [
      '{"event":"route_rate_limited","route":"/api/x"}',
      '{"event":"route_rate_limited"}',
      '{"event":"attack_request_refused"}',
      '{"event":"audit.plan_changed"}',
      "not json",
    ].join("\n");
    expect(refusals(log)).toEqual({ route_rate_limited: 2, attack_request_refused: 1 });
    expect(summary(judge({ report: report("1"), zapLog: done, stillSignedIn: true }), refusals(log))).toContain("refused: 3");
  });

});
