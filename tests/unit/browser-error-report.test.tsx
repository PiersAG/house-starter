// @vitest-environment jsdom
//
// The browser half of error tracking (app-business-core issue 761): the page
// posts its errors to the app's own /api/error-report — only once
// components/ErrorReporter.tsx is mounted (the root layout mounts it only while
// error tracking is on and connected), with the page's path and never its
// query, a few per page, each different error once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ErrorReporter } from "@/components/ErrorReporter";
import {
  ERROR_REPORT_PATH,
  controlName,
  disableBrowserReports,
  rageClickWatcher,
  enableBrowserReports,
  reportBody,
  sendBrowserError,
} from "@/lib/observability/browser-report";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  disableBrowserReports();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/dashboard/clients?name=jane#notes");
});

afterEach(() => {
  disableBrowserReports();
  vi.unstubAllGlobals();
});

describe("sendBrowserError", () => {
  it("sends nothing until the reporter has switched it on (error tracking off)", () => {
    expect(sendBrowserError(new Error("x"), "error")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the type, message, stack and page path — never the query or fragment", () => {
    enableBrowserReports(5);
    expect(sendBrowserError(new TypeError("x is undefined"), "error")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ERROR_REPORT_PATH);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", keepalive: true });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ type: "TypeError", message: "x is undefined", page: "/dashboard/clients", kind: "error" });
    expect(String(init.body)).not.toContain("jane");
  });

  it("sends each different error once, and at most the page's limit", () => {
    enableBrowserReports(2);
    sendBrowserError(new Error("a"), "error");
    sendBrowserError(new Error("a"), "error");
    sendBrowserError(new Error("b"), "error");
    sendBrowserError(new Error("c"), "error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("copes with a thrown value that is not an Error", () => {
    expect(JSON.parse(reportBody("plain text", "unhandledrejection", "/") ?? "{}")).toMatchObject({
      type: "Error",
      message: "plain text",
      stack: null,
      kind: "unhandledrejection",
    });
    expect(JSON.parse(reportBody(undefined, "error", "/x?y") ?? "{}").page).toBe("/x");
  });
});

describe("<ErrorReporter>", () => {
  // The handlers are called directly: a real dispatched error event counts as
  // an unhandled error in the test run.
  it("reports an uncaught error and an unhandled rejection while mounted, and removes its handlers after", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<ErrorReporter maxReportsPerPage={5} />);
    const handler = (type: string) => add.mock.calls.find((c) => c[0] === type)?.[1] as (e: unknown) => void;
    handler("error")({ error: new Error("uncaught"), message: "uncaught" });
    handler("unhandledrejection")({ reason: new Error("rejected") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).kind).toBe("unhandledrejection");
    view.unmount();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["error", "unhandledrejection"]));
    expect(sendBrowserError(new Error("later"), "error")).toBe(false);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("rage clicks (issue 736)", () => {
  it("three clicks on one control within a second are reported once, naming the control, not its text", () => {
    enableBrowserReports(5);
    document.body.innerHTML = '<button id="save" data-testid="save-button"><span>Save Jane\'s notes</span></button><a id="other">x</a>';
    let t = 0;
    const watch = rageClickWatcher(() => t);
    const span = document.querySelector("span") as HTMLElement;
    for (const at of [0, 300, 600, 900, 1000]) {
      t = at;
      watch({ target: span } as unknown as Event);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ type: "RageClick", message: "Rage click on button#save[data-testid=save-button]", kind: "rage_click" });
    expect(JSON.stringify(body)).not.toContain("Jane");
  });

  it("slow clicks, and clicks on nothing clickable, are not rage clicks", () => {
    enableBrowserReports(5);
    document.body.innerHTML = '<button id="go">Go</button><p id="text">text</p>';
    let t = 0;
    const watch = rageClickWatcher(() => t);
    const go = document.getElementById("go") as HTMLElement;
    const p = document.getElementById("text") as HTMLElement;
    for (const at of [0, 600, 1200, 1800]) {
      t = at;
      watch({ target: go } as unknown as Event);
      watch({ target: p } as unknown as Event);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(controlName(p)).toBeNull();
  });
});
