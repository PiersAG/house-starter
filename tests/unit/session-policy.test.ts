// @vitest-environment node
// The session rules and the access policy — pure (app-business-core issues 519,
// 525, 559, 741). Both states of every switch: the session setting (SESSION_POLICY,
// CEO decision #559), the sign-in risk checks and context-aware access.

import { describe, expect, it } from "vitest";
import { evaluateAccess, type AccessAttributes } from "@/lib/session/policy";
import { assessSignIn, haversineKm, isImpossibleTravel, isUnusualHour, localHour, scoreSession } from "@/lib/session/risk";
import { pastAbsoluteLife, renewAfterSeconds, sessionMaxAge } from "@/lib/session/lifetime";
import { DEFAULT_RETURN_PATH, loginPathFor, safeReturnPath } from "@/lib/session/return-path";
import { SESSION_POLICY } from "@/config/sessions";
import { ACTION_SENSITIVITY } from "@/config/data-sensitivity";

describe("#559 the one session setting", () => {
  it("is today's ruling until the CEO decides", () => {
    expect(SESSION_POLICY).toBe("renewal");
  });

  it("renewal: 1 day / 30 days, checked every 10 minutes (the 2026-07-15 ruling)", () => {
    expect(sessionMaxAge(false, "renewal")).toBe(86_400);
    expect(sessionMaxAge(true, "renewal")).toBe(30 * 86_400);
    expect(renewAfterSeconds("renewal")).toBe(600);
    expect(pastAbsoluteLife(0, false, 10 * 86_400, "renewal")).toBe(false);
  });

  it("strict: checked on every server request (instant revocation); 8 hours / 7 days from sign-in", () => {
    expect(renewAfterSeconds("strict")).toBe(0);
    expect(sessionMaxAge(false, "strict")).toBe(8 * 3600);
    expect(sessionMaxAge(true, "strict")).toBe(7 * 86_400);
    expect(pastAbsoluteLife(1000, false, 1000 + 8 * 3600, "strict")).toBe(false);
    expect(pastAbsoluteLife(1000, false, 1001 + 8 * 3600, "strict")).toBe(true);
  });
});

describe("#519 the risk rules", () => {
  it("measures distance", () => {
    expect(Math.round(haversineKm({ latitude: 51.5, longitude: -0.12 }, { latitude: 48.86, longitude: 2.35 }))).toBeGreaterThan(330);
    expect(Math.round(haversineKm({ latitude: 51.5, longitude: -0.12 }, { latitude: 48.86, longitude: 2.35 }))).toBeLessThan(350);
  });

  it("London to Sydney in ten minutes is impossible; in a day it is not; a missing reading never is", () => {
    const a = { latitude: 51.5, longitude: -0.12, atMs: 0 };
    expect(isImpossibleTravel(a, { latitude: -33.87, longitude: 151.21, atMs: 600_000 })).toBe(true);
    expect(isImpossibleTravel(a, { latitude: -33.87, longitude: 151.21, atMs: 26 * 3_600_000 })).toBe(false);
    expect(isImpossibleTravel(a, { latitude: 51.6, longitude: -0.1, atMs: 1000 })).toBe(false);
    expect(isImpossibleTravel(a, { latitude: null, longitude: null, atMs: 1000 })).toBe(false);
  });

  it("a sign-in is unfamiliar only when both its device and its country are new", () => {
    expect(assessSignIn({ hasHistory: false, knownDevice: false, knownCountry: false, country: "FR" })).toBe("first");
    expect(assessSignIn({ hasHistory: true, knownDevice: true, knownCountry: false, country: "FR" })).toBe("familiar");
    expect(assessSignIn({ hasHistory: true, knownDevice: false, knownCountry: true, country: "FR" })).toBe("familiar");
    expect(assessSignIn({ hasHistory: true, knownDevice: false, knownCountry: false, country: null })).toBe("familiar");
    expect(assessSignIn({ hasHistory: true, knownDevice: false, knownCountry: false, country: "FR" })).toBe("unfamiliar");
  });

  it("reads the local hour, and 3 a.m. is unusual", () => {
    expect(localHour("Europe/London", Date.parse("2026-11-02T03:00:00Z"))).toBe(3);
    expect(localHour("Asia/Tokyo", Date.parse("2026-11-02T03:00:00Z"))).toBe(12);
    expect(localHour(null, 0)).toBeNull();
    expect(localHour("Not/AZone", 0)).toBeNull();
    expect(isUnusualHour(3)).toBe(true);
    expect(isUnusualHour(9)).toBe(false);
    expect(isUnusualHour(null)).toBe(false);
  });

  it("scores a session: unusual volume steps up, impossible travel or a banned connection ends it", () => {
    const calm = { impossibleTravel: false, countryChanged: false, otherDevice: false, reputation: "good" as const };
    expect(scoreSession(calm)).toEqual({ score: 0, action: "none", reasons: [] });
    expect(scoreSession({ ...calm, reputation: "suspect" }).action).toBe("step_up");
    expect(scoreSession({ ...calm, countryChanged: true }).action).toBe("none");
    expect(scoreSession({ ...calm, countryChanged: true, otherDevice: true }).action).toBe("step_up");
    expect(scoreSession({ ...calm, impossibleTravel: true }).action).toBe("end");
    expect(scoreSession({ ...calm, reputation: "bad" }).action).toBe("end");
  });
});

describe("#741 the access policy (Matt Murphy #89)", () => {
  const base: AccessAttributes = {
    sensitivity: "high",
    deviceKnown: true,
    unusualHour: false,
    reputation: "good",
    sessionRisk: 0,
    signInAgeSeconds: 3600,
  };

  it("financial records at 3 a.m. from an unrecognised device: stepped up; after a fresh sign-in, allowed", () => {
    expect(ACTION_SENSITIVITY["billing.portal"]).toBe("high");
    const night = { ...base, deviceKnown: false, unusualHour: true };
    expect(evaluateAccess(night, true).decision).toBe("step_up");
    expect(evaluateAccess({ ...night, signInAgeSeconds: 60 }, true).decision).toBe("allow");
  });

  it("denied entirely: a banned connection, a session at the end mark, or every warning sign at once", () => {
    expect(evaluateAccess({ ...base, reputation: "bad" }, true).decision).toBe("deny");
    expect(evaluateAccess({ ...base, sessionRisk: 100 }, true).decision).toBe("deny");
    expect(
      evaluateAccess({ ...base, deviceKnown: false, unusualHour: true, reputation: "suspect", sessionRisk: 60, signInAgeSeconds: 5 }, true)
        .decision,
    ).toBe("deny");
  });

  it("an ordinary request is allowed; a suspect connection steps up only sensitive data", () => {
    expect(evaluateAccess(base, true).decision).toBe("allow");
    expect(evaluateAccess({ ...base, sensitivity: "normal", reputation: "suspect", deviceKnown: false, unusualHour: true }, true).decision).toBe("allow");
    expect(evaluateAccess({ ...base, reputation: "suspect" }, true).decision).toBe("step_up");
    expect(evaluateAccess({ ...base, sessionRisk: 50 }, true).decision).toBe("step_up");
  });

  it("with context-aware access OFF everything is allowed (both states)", () => {
    expect(evaluateAccess({ ...base, reputation: "bad", deviceKnown: false, unusualHour: true }, false).decision).toBe("allow");
  });
});

describe("#525 return to where the user was, never off the app", () => {
  it.each([
    ["/account/security", "/account/security"],
    ["/dashboard/settings?tab=billing", "/dashboard/settings?tab=billing"],
    ["/dashboard#top", "/dashboard#top"],
  ])("keeps the local path %s", (input, want) => {
    expect(safeReturnPath(input)).toBe(want);
  });

  it.each([
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "javascript:alert(1)",
    "/javascript:alert(1)",
    "/login",
    "/api/auth/signin",
    "",
    "dashboard",
    "/a\nb",
    42,
    null,
  ])("refuses %s", (input) => {
    expect(safeReturnPath(input)).toBe(DEFAULT_RETURN_PATH);
  });

  it("builds the sign-in path with the return path encoded", () => {
    expect(loginPathFor("/account/security")).toBe("/login?callbackUrl=%2Faccount%2Fsecurity");
    expect(loginPathFor("https://evil.example")).toBe("/login?callbackUrl=%2Fdashboard");
  });
});
