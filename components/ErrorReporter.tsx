"use client";

// Catches the page's uncaught errors and unhandled promise rejections, and
// rage clicks (issue 736), and sends each to the app's own /api/error-report
// (app-business-core issue 761).
// Mounted by app/layout.tsx ONLY while error tracking is on and connected
// (config/error-tracking.ts, lib/observability/sentry-dsn.ts): when it is not
// mounted, lib/observability/browser-report.ts sends nothing. Renders nothing.

import { useEffect } from "react";
import {
  disableBrowserReports,
  enableBrowserReports,
  rageClickWatcher,
  sendBrowserError,
} from "@/lib/observability/browser-report";

export function ErrorReporter({ maxReportsPerPage }: { maxReportsPerPage: number }) {
  useEffect(() => {
    enableBrowserReports(maxReportsPerPage);
    const onError = (event: ErrorEvent) => sendBrowserError(event.error ?? event.message, "error");
    const onRejection = (event: PromiseRejectionEvent) => sendBrowserError(event.reason, "unhandledrejection");
    const onClick = rageClickWatcher();
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("click", onClick, true);
      disableBrowserReports();
    };
  }, [maxReportsPerPage]);
  return null;
}
