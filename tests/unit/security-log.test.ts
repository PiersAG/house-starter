// The security event line (lib/security-log.ts): one JSON line per event, ids
// and plain values only, never throws.

import { afterEach, describe, expect, it, vi } from "vitest";
import { logSecurityEvent, securityLogLine } from "@/lib/security-log";

afterEach(() => vi.restoreAllMocks());

describe("securityLogLine", () => {
  it("writes the event, the time and plain values; drops anything else", () => {
    const at = new Date("2026-11-01T09:00:00Z");
    const line = securityLogLine(
      "password_changed",
      {
        userId: "u1",
        count: 2,
        known: false,
        none: null,
        // Anything not a plain value is dropped, so an object cannot smuggle a secret in.
        nested: { token: "secret" } as unknown as string,
        list: ["secret"] as unknown as string,
      },
      at,
    );
    expect(JSON.parse(line)).toEqual({
      security_event: "password_changed",
      at: "2026-11-01T09:00:00.000Z",
      userId: "u1",
      count: 2,
      known: false,
      none: null,
    });
    expect(line).not.toContain("secret");
  });

  it("defaults to no fields and the current time", () => {
    const parsed = JSON.parse(securityLogLine("signed_out_everywhere"));
    expect(parsed.security_event).toBe("signed_out_everywhere");
    expect(Number.isNaN(Date.parse(parsed.at))).toBe(false);
  });
});

describe("logSecurityEvent", () => {
  it("writes one line to the warning log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSecurityEvent("session_token_rejected", { reason: "JWTExpired" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      security_event: "session_token_rejected",
      reason: "JWTExpired",
    });
  });

  it("never throws, even when the console does", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console down");
    });
    expect(() => logSecurityEvent("password_changed")).not.toThrow();
  });
});
