// The browser half of error tracking (PiersAG/app-business-core#761): post one
// error to the app's own /api/error-report, which scrubs it and passes it on to
// Sentry (lib/observability/sentry.ts). Client-safe: no server import.
//
// It sends only after components/ErrorReporter.tsx has switched it on for the
// page — the root layout mounts that component only while error tracking is on
// and connected (config/error-tracking.ts) — so with the switch off this sends
// nothing at all. It sends the error's type, message and stack and the page's
// path (never its query or fragment), at most a few per page, each different
// error once; the session cookie travels with it so the server can attach the
// account's opaque id. Never throws.
//
// RAGE CLICKS (app-business-core issue 736; Matt Murphy #173: "detect rage
// clicks and flag them as ux failures before a support ticket is filed"):
// three or more clicks on the same control within a second are reported once
// per control per page, naming the control by its tag, id and test id only —
// never its text or anything typed.

export const ERROR_REPORT_PATH = "/api/error-report";

export type BrowserErrorKind = "error" | "unhandledrejection" | "boundary" | "rage_click";

/** Clicks on one control, inside RAGE_WINDOW_MS, that count as a rage click. */
export const RAGE_CLICKS = 3;
export const RAGE_WINDOW_MS = 1000;

const state = { on: false, max: 0, sent: 0, seen: new Set<string>() };

/** Switch sending on for this page (ErrorReporter), with the per-page limit. */
export function enableBrowserReports(maxPerPage: number): void {
  state.on = true;
  state.max = Math.max(0, Math.floor(maxPerPage));
}

/** Switch it off again (ErrorReporter unmounting; tests). */
export function disableBrowserReports(): void {
  state.on = false;
  state.sent = 0;
  state.seen.clear();
}

/** The report body for an error, or null when there is nothing to send. */
export function reportBody(error: unknown, kind: BrowserErrorKind, page: string): string | null {
  const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
  const type = typeof e?.name === "string" && e.name ? e.name.slice(0, 100) : "Error";
  const message =
    typeof e?.message === "string" ? e.message : typeof error === "string" ? error : "Non-error value thrown";
  const stack = typeof e?.stack === "string" ? e.stack.slice(0, 8000) : null;
  return JSON.stringify({
    type,
    message: message.slice(0, 2000),
    stack,
    page: (page.split(/[?#]/)[0] || "/").slice(0, 500),
    kind,
  });
}

/** Send one browser error, if sending is on and the page's limit allows. True when sent. */
export function sendBrowserError(error: unknown, kind: BrowserErrorKind): boolean {
  try {
    if (!state.on || state.sent >= state.max) return false;
    const page = typeof location !== "undefined" ? location.pathname : "/";
    const body = reportBody(error, kind, page);
    if (!body) return false;
    const key = body.slice(0, 600);
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    state.sent += 1;
    void fetch(ERROR_REPORT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

const SAFE_ATTR = /^[A-Za-z][\w-]{0,40}$/;

/** The control a click landed on, named without its text: "button#save[data-testid=submit]". */
export function controlName(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.("button, a, input, select, summary, label, [role=button], [role=link], [onclick]");
  if (!el) return null;
  let name = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id && SAFE_ATTR.test(id)) name += `#${id}`;
  const testId = el.getAttribute("data-testid");
  if (testId && SAFE_ATTR.test(testId)) name += `[data-testid=${testId}]`;
  const role = el.getAttribute("role");
  if (role && SAFE_ATTR.test(role)) name += `[role=${role}]`;
  return name;
}

/** Watch for rage clicks: a click handler that reports one per control per page. */
export function rageClickWatcher(now: () => number = () => Date.now()): (event: Event) => void {
  const clicks = new Map<string, number[]>();
  const reported = new Set<string>();
  return (event: Event) => {
    const name = controlName(event.target);
    if (!name || reported.has(name)) return;
    const t = now();
    const recent = (clicks.get(name) ?? []).filter((at) => t - at < RAGE_WINDOW_MS);
    recent.push(t);
    clicks.set(name, recent);
    if (recent.length >= RAGE_CLICKS) {
      reported.add(name);
      clicks.delete(name);
      sendBrowserError({ name: "RageClick", message: `Rage click on ${name}` }, "rage_click");
    }
  };
}
