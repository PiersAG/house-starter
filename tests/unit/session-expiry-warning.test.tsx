// @vitest-environment jsdom
// The session-expiry warning (app-business-core issue 525; Matt Murphy step 153:
// "warn 60s before expiry with 'stay signed in'").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionExpiryWarning } from "@/components/session/SessionExpiryWarning";

const NOW = Date.parse("2026-11-02T12:00:00Z");
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, pathname: "/dashboard/settings", search: "?tab=a", assign },
  });
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#525 the expiry warning", () => {
  it("stays hidden until 60 seconds before the end, then offers 'Stay signed in'", async () => {
    render(<SessionExpiryWarning expiresAt={NOW + 120_000} maxAgeSeconds={86_400} />);
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeTruthy();
  });

  it("'Stay signed in' renews the session and closes the warning", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { id: "u" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionExpiryWarning expiresAt={NOW + 30_000} maxAgeSeconds={86_400} />);
    await act(async () => vi.advanceTimersByTime(1_000));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ cache: "no-store" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // well past the old end: no sign-in redirect, the session was renewed
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(assign).not.toHaveBeenCalled();
  });

  it("a session that could not be renewed goes to sign in, coming back to this page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<SessionExpiryWarning expiresAt={NOW + 30_000} maxAgeSeconds={86_400} />);
    await act(async () => vi.advanceTimersByTime(1_000));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    });
    expect(assign).toHaveBeenCalledWith("/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Da");
  });

  it("when the session runs out, typed text is kept and the user is sent to sign in", async () => {
    document.body.insertAdjacentHTML("beforeend", '<form id="f" data-keep-draft><textarea name="note"></textarea></form>');
    (document.querySelector("textarea") as HTMLTextAreaElement).value = "half-written";
    render(<SessionExpiryWarning expiresAt={NOW + 5_000} maxAgeSeconds={86_400} />);
    await act(async () => vi.advanceTimersByTime(6_000));
    expect(assign).toHaveBeenCalledWith("/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Da");
    expect(JSON.stringify(Object.fromEntries(Object.entries(window.sessionStorage)))).toContain("half-written");
  });
});
