// Per-request context for the structured log (PiersAG/app-business-core#503,
// #806). Holds what a request's log line and access records need — its id,
// route and method, and, once the session is read, the user and tenant — so
// code deep in lib/ can attach them without every function passing them on.
//
// Node.js runtime only (AsyncLocalStorage). Outside a request (a script, boot,
// a test) there is no context and every reader answers null.

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  route: string | null;
  method: string | null;
  userId: string | null;
  /** The signed-in caller's tenant, once the session has been read. */
  tenantId: string | null;
  /** Tenants whose data this request has opened (one access record each). */
  tenantsOpened: Set<string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a fresh context for one request. */
export function runWithRequest<T>(
  init: { requestId: string; route?: string | null; method?: string | null },
  fn: () => T,
): T {
  return storage.run(
    {
      requestId: init.requestId,
      route: init.route ?? null,
      method: init.method ?? null,
      userId: null,
      tenantId: null,
      tenantsOpened: new Set(),
    },
    fn,
  );
}

/** The current request's context, or null outside a request. */
export function currentRequest(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** Record who the caller is, once the session is known. No-op outside a request. */
export function noteRequestUser(userId: string | null, tenantId: string | null): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (userId) ctx.userId = userId;
  if (tenantId) ctx.tenantId = tenantId;
}
