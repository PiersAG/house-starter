// @vitest-environment node
//
// The two signed-in billing write endpoints — start a subscription
// (app/api/billing/checkout) and open the billing portal (app/api/billing/portal)
// — need this session's request token from the app's own origin (lib/csrf.ts,
// app-business-core issue 353; Matt Murphy #68: "SameSite cookies +
// request-verification tokens on every state-changing endpoint"). Driven through
// their real handlers and the real lib/csrf.ts, both ways:
//   • refused 403, with no Stripe call: no token, another session's token, a
//     made-up token, and this session's token sent from another website;
//   • answered with the Stripe address: this session's token from the app's own
//     origin (and from a client that sends no Origin, as a non-browser does).
// Signed out is still 401, before the token is read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  session: null as unknown,
  checkout: vi.fn(async () => ({ url: "https://checkout.stripe.test/c/1" })),
  portal: vi.fn(async () => ({ url: "https://billing.stripe.test/p/1" })),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => holder.session }));
vi.mock("@/lib/catalog", () => ({ catalogDb: {}, getCatalogDb: () => ({}) }));
vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: holder.checkout } },
    billingPortal: { sessions: { create: holder.portal } },
  }),
}));
vi.mock("@/lib/billing/subscriptions", () => ({
  getSubscriptionByUserId: async () => ({ stripeCustomerId: "cus_test_owner" }),
}));
// Access by connection is tests/unit/session-access-guard.test.ts's concern; the
// route limit and the request log are their own tests'. Here they let it through.
vi.mock("@/lib/session/guard", () => ({
  checkSensitiveAccess: async () => ({ decision: "allow", loginPath: "/login" }),
  accessMessage: () => null,
}));
vi.mock("@/lib/abuse/route-limit", () => ({
  withRouteLimit: (_name: string, handler: unknown) => handler,
}));
vi.mock("@/lib/observability/with-request-log", () => ({
  withRequestLog: (_route: string, handler: unknown) => handler,
}));

// Imported after the mocks are registered.
import { POST as checkoutPOST } from "@/app/api/billing/checkout/route";
import { POST as portalPOST } from "@/app/api/billing/portal/route";
import { CSRF_HEADER, csrfTokenFor } from "@/lib/csrf";

const ORIGIN = "https://app.example.com";
const OWNER = { user: { id: "user-owner", email: "owner@example.com", sessionId: "session-1" } };

type Handler = (request: Request) => Promise<Response>;
const ROUTES: { name: string; handler: Handler; stripe: ReturnType<typeof vi.fn> }[] = [
  { name: "checkout", handler: checkoutPOST as Handler, stripe: holder.checkout },
  { name: "portal", handler: portalPOST as Handler, stripe: holder.portal },
];

function post(name: string, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/billing/${name}`, { method: "POST", headers });
}

beforeEach(() => {
  process.env.AUTH_SECRET ??= "billing-csrf-test-secret-not-used-anywhere-real";
  process.env.APP_CANONICAL_URL = ORIGIN;
  holder.session = OWNER;
  holder.checkout.mockClear();
  holder.portal.mockClear();
});

afterEach(() => {
  delete process.env.APP_CANONICAL_URL;
});

describe.each(ROUTES)("POST /api/billing/$name needs this session's request token (#353)", ({ name, handler, stripe }) => {
  const token = () => csrfTokenFor(OWNER)!;
  const other = () => csrfTokenFor({ user: { id: "user-owner", sessionId: "session-2" } })!;

  it.each([
    ["no token", () => ({ origin: ORIGIN })],
    ["another session's token", () => ({ origin: ORIGIN, [CSRF_HEADER]: other() })],
    ["a made-up token", () => ({ origin: ORIGIN, [CSRF_HEADER]: "A".repeat(43) })],
    ["this session's token from another website", () => ({ origin: "https://evil.example", [CSRF_HEADER]: token() })],
    ["this session's token, cross-site by Sec-Fetch-Site", () => ({ "sec-fetch-site": "cross-site", [CSRF_HEADER]: token() })],
  ])("refuses %s, before any Stripe call", async (_label, headers) => {
    const res = await handler(post(name, headers()));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(stripe).not.toHaveBeenCalled();
  });

  it("answers with the Stripe address for this session's token from the app's own origin", async () => {
    const sends: Record<string, string>[] = [
      { origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: token() },
      { [CSRF_HEADER]: token() },
    ];
    for (const headers of sends) {
      const res = await handler(post(name, headers));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { url?: string }).url).toMatch(/^https:\/\/(checkout|billing)\.stripe\.test\//);
    }
    expect(stripe).toHaveBeenCalledTimes(2);
  });

  it("still answers 401 when signed out, before the token is read", async () => {
    holder.session = null;
    const res = await handler(post(name, { origin: ORIGIN, [CSRF_HEADER]: token() }));
    expect(res.status).toBe(401);
    expect(stripe).not.toHaveBeenCalled();
  });
});
