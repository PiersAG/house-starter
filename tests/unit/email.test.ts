// Email send-path tests (v0 graduation — Candidate 2).
//
// Covers the provider-agnostic send path: mode resolution, log-mode capture
// (what CI and previews use), and the live-mode provider seam with the concrete
// provider mocked — so "sent via the configured provider" is asserted directly
// without a network call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the concrete provider module so live-mode sends hit a spy, never
// Resend. Scoped to this file.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock("@/lib/email/provider", () => ({
  getEmailProvider: () => ({ send: sendSpy }),
  __resetEmailProviderForTests: () => {},
}));

import {
  clearCapturedEmails,
  getCapturedEmails,
  getEmailSendMode,
  sendEmail,
} from "@/lib/email/send";
import { resetPasswordTemplate } from "@/lib/email/templates/reset-password";

const ENV_KEYS = ["EMAIL_SEND_MODE", "EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  clearCapturedEmails();
  sendSpy.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("getEmailSendMode", () => {
  it("defaults to log when unset", () => {
    delete process.env.EMAIL_SEND_MODE;
    expect(getEmailSendMode()).toBe("log");
  });

  it("accepts live", () => {
    process.env.EMAIL_SEND_MODE = "LIVE";
    expect(getEmailSendMode()).toBe("live");
  });

  it("throws on an unknown mode", () => {
    process.env.EMAIL_SEND_MODE = "smtp";
    expect(() => getEmailSendMode()).toThrow(/EMAIL_SEND_MODE/);
  });
});

describe("sendEmail — log mode (CI/previews never send real mail)", () => {
  it("captures the rendered message and touches no provider", async () => {
    process.env.EMAIL_SEND_MODE = "log";

    const result = await sendEmail("user@example.com", resetPasswordTemplate, {
      resetUrl: "https://app.example.com/reset-password?token=abc",
    });

    expect(result).toEqual({ mode: "log", to: "user@example.com", template: "reset-password" });
    expect(sendSpy).not.toHaveBeenCalled();

    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("user@example.com");
    expect(captured[0].subject).toBe("Reset your password");
    expect(captured[0].html).toContain("https://app.example.com/reset-password?token=abc");
    expect(captured[0].text).toContain("https://app.example.com/reset-password?token=abc");
  });
});

describe("sendEmail — live mode (via the configured provider)", () => {
  it("sends through the provider with EMAIL_FROM and returns its id", async () => {
    process.env.EMAIL_SEND_MODE = "live";
    process.env.EMAIL_FROM = "noreply@example.com";
    sendSpy.mockResolvedValue({ id: "re_123" });

    const result = await sendEmail("user@example.com", resetPasswordTemplate, {
      resetUrl: "https://app.example.com/reset-password?token=xyz",
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "Reset your password",
      }),
    );
    expect(result).toEqual({
      mode: "live",
      to: "user@example.com",
      template: "reset-password",
      id: "re_123",
    });
    // Live sends are not captured.
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("throws when EMAIL_FROM is missing in live mode", async () => {
    process.env.EMAIL_SEND_MODE = "live";
    delete process.env.EMAIL_FROM;
    await expect(
      sendEmail("user@example.com", resetPasswordTemplate, {
        resetUrl: "https://app.example.com/reset-password?token=xyz",
      }),
    ).rejects.toThrow(/EMAIL_FROM/);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
