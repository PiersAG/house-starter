// Safety-net screens (app-business-core issue 502): what each shows, and that
// none shows an error's message or stack — only its digest as a reference.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";
import DashboardLoading from "@/app/dashboard/loading";
import { OfflineNotice } from "@/components/OfflineNotice";

const boom = Object.assign(new Error("SQLITE_ERROR at /srv/app/lib/db.ts:12"), { digest: "123456789" });

describe("the crash screen", () => {
  it("shows plain words, the digest and a working Try again — never the message", () => {
    const reset = vi.fn();
    render(<ErrorPage error={boom} reset={reset} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByTestId("error-reference").textContent).toBe("123456789");
    expect(document.body.textContent).not.toContain("SQLITE_ERROR");
    expect(document.body.textContent).not.toContain("/srv/app");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("without a digest shows no reference line", () => {
    render(<ErrorPage error={new Error("x")} reset={() => {}} />);
    expect(screen.queryByTestId("error-reference")).toBeNull();
  });

  it("the global screen shows the same message", () => {
    const reset = vi.fn();
    render(<GlobalError error={boom} reset={reset} />, { container: document });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("SQLITE_ERROR");
  });
});

describe("not found and loading", () => {
  it("not-found offers a way on", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the home page" }).getAttribute("href")).toBe("/");
  });

  it("the dashboard loading screen is announced", () => {
    render(<DashboardLoading />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
  });
});

describe("the offline notice", () => {
  it("appears when the connection drops and goes when it is back", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    render(<OfflineNotice />);
    expect(screen.queryByText(/You are offline/)).toBeNull();
    online.mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("status").textContent).toContain("You are offline");
    online.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.queryByText(/You are offline/)).toBeNull();
  });
});
