// One structured log line per API request (PiersAG/app-business-core#503;
// Matt Murphy #207, #319): request id, route, method, status, duration, user and
// tenant — never the body or the headers.
//
//   export const GET = withRequestLog("/api/tenant", async (request) => { … });
//
// The request id is the one the edge middleware set (x-request-id); a request
// that reached the handler without one gets a fresh id here. It is returned to
// the browser on the response and attached to any error row, so one search
// shows the whole request. A request slower than SLOW_REQUEST_MS (default
// 1000 ms) is logged at warn and counted on /api/health.
//
// An error the handler throws is recorded in the durable error log with the
// request id, and the caller gets a fixed message carrying only that id as a
// support reference — never the error's own text (ASVS V7.4.1).

import "server-only";

import { NextResponse } from "next/server";
import { recordError } from "@/lib/observability/error-log";
import { logEvent, slowRequestMs } from "@/lib/observability/log";
import { currentRequest, runWithRequest } from "@/lib/observability/request-context";
import { REQUEST_ID_HEADER, newRequestId, safeRequestId } from "@/lib/observability/request-id";

type Handler<A extends unknown[]> = (request: Request, ...rest: A) => Promise<Response> | Response;

/** Wrap a route handler so every request writes one line and carries its id. */
export function withRequestLog<A extends unknown[]>(route: string, handler: Handler<A>): Handler<A> {
  return async (request: Request, ...rest: A): Promise<Response> => {
    const requestId = safeRequestId(request.headers) ?? newRequestId();
    const started = performance.now();
    return runWithRequest({ requestId, route, method: request.method }, async () => {
      let response: Response;
      try {
        response = await handler(request, ...rest);
      } catch (e) {
        await recordError({
          message: e instanceof Error ? e.message : "non-Error thrown",
          stack: e instanceof Error ? (e.stack ?? null) : null,
          route,
          method: request.method,
          requestId,
          level: "error",
        });
        response = NextResponse.json(
          { error: "Something went wrong. Please try again.", reference: requestId },
          { status: 500 },
        );
      }
      const durationMs = performance.now() - started;
      const slow = durationMs >= slowRequestMs();
      const ctx = currentRequest();
      logEvent({
        level: response.status >= 500 ? "error" : slow ? "warn" : "info",
        event: "request",
        status: response.status,
        durationMs,
        userId: ctx?.userId,
        tenantId: ctx?.tenantId,
        fields: { slow },
      });
      try {
        response.headers.set(REQUEST_ID_HEADER, requestId);
      } catch {
        // An immutable response (a redirect from Response.redirect): copy it.
        response = new Response(response.body, response);
        response.headers.set(REQUEST_ID_HEADER, requestId);
      }
      return response;
    });
  };
}
