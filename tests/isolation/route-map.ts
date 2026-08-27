// Route map for the isolation suite — ONE discovery, read by two consumers.
//
// WHY THIS FILE EXISTS (item 16a)
// -------------------------------
// The cross-tenant attack in per-tenant.spec.ts discovers its own targets by
// walking `app/`, so a route the builder adds is attacked the next time it runs
// — no hand-maintained target list to forget to update. That is the right
// design and it is unchanged here.
//
// What it could NOT do was notice a writable route it was never going to see.
// Discovery dropped every path under `PUBLIC_PREFIXES` silently, inside the
// discovery function itself, so a new `POST /api/auth/change-email` (or any
// other writable handler placed under an excluded prefix) simply never appeared
// in the attack and nothing anywhere said so. "Every writable route is attacked"
// depended on somebody remembering.
//
// So discovery is split in two here:
//
//   discoverAllRoutes()  — every route under `app/`, nothing removed, WITH the
//                          HTTP verbs each API handler actually exports.
//   attackableRoutes()   — the same list minus the declared exclusions. This is
//                          byte-for-byte what the attack used to compute itself.
//
// and the difference between them is now a DECLARATION rather than a side
// effect: ROUTE_EXCLUSIONS carries a written reason per prefix, and any WRITABLE
// route that falls into that gap must additionally be named, exactly, in
// WRITABLE_ROUTE_EXEMPTIONS. tests/unit/isolation-route-coverage.test.ts asserts
// all of that and fails the build when it does not hold — which is what makes
// coverage structural instead of remembered.
//
// It also lets the coverage guard run where the attack cannot: the guard reads
// the source tree only, so it runs on house-starter itself (which provisions no
// tenants and therefore skips the attack) as well as on every generated app.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The verbs that count as a WRITE for coverage purposes. A route exporting only
 * GET/HEAD/OPTIONS cannot modify anything, so it is not a writable route and
 * needs no exemption — that is derived from the source, never declared.
 */
export const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

/** Every verb Next.js will route to a named export in a `route.ts`. */
const ROUTE_EXPORT_VERBS = [
  "GET",
  "HEAD",
  "OPTIONS",
  ...WRITE_VERBS,
] as const;

/**
 * Verbs the SENTINEL write leg tries. Each carries a unique string into the
 * request body, so "where did it land" has an answer that can be read straight
 * out of the databases afterwards.
 *
 * DELETE is deliberately NOT here: it carries no sentinel, because it writes
 * nothing. It is attacked by its own leg, which proves the negative a different
 * way — a row that was there before is still there after (see DELETE_METHOD).
 */
export const WRITE_METHODS = ["POST", "PUT", "PATCH"] as const;

/**
 * The verb the DELETE leg issues (item 16b). Separate from WRITE_METHODS
 * because the assertion is different in kind, not because the coverage is
 * optional.
 */
export const DELETE_METHOD = "DELETE" as const;

/**
 * Every verb the attack actually issues, across both legs. The coverage guard
 * compares this against the verbs the app's own routes export: a route
 * exporting a verb nobody attacks is an uncovered door, and CI says so.
 */
export const ATTACKED_METHODS = [...WRITE_METHODS, DELETE_METHOD] as const;

/** A route as discovered from the source tree, with its shape preserved. */
export type DiscoveredRoute = {
  /** URL path, `[dynamic]` segments left in place: `/api/settings/[key]`. */
  path: string;
  /** Parameter names, in path order: `["key"]`. Empty for a static route. */
  params: string[];
  /** `route.ts` is an API handler; `page.tsx` is a page. */
  kind: "api" | "page";
  /** Path to the `route.ts` on disk; null for a page route. */
  file: string | null;
  /**
   * HTTP verbs this handler exports, uppercase and sorted. Empty for a page
   * route — a page accepts a POST only as a server action, which carries a
   * build-time action id no test can synthesise.
   */
  methods: string[];
};

/**
 * Routes NOT attacked, and why. This is the seam: everything here is deliberately
 * out of the attack's reach, so every entry states the reason it is safe to leave
 * out. A prefix matches the path itself and everything beneath it.
 *
 * A prefix here is enough for a page or a read-only handler. It is NOT enough for
 * a WRITABLE handler — those must also be named in WRITABLE_ROUTE_EXEMPTIONS, so
 * that a new writable route dropped under an existing prefix cannot inherit an
 * exemption written for its neighbours.
 */
export const ROUTE_EXCLUSIONS: { prefix: string; reason: string }[] = [
  {
    prefix: "/login",
    reason: "public by design — an unauthenticated page leaking nothing proves nothing",
  },
  {
    prefix: "/signup",
    reason: "public by design — reached before any session exists",
  },
  {
    prefix: "/contact",
    reason: "public by design — reached before any session exists",
  },
  {
    prefix: "/reset-password",
    reason: "public by design — reached from an emailed token, not a session",
  },
  {
    prefix: "/reactivate",
    reason: "public by design — reached by a lapsed account before it has a usable session",
  },
  {
    prefix: "/api/auth",
    reason:
      "NextAuth internals — exercised by the login flow the attack itself uses, not attacked directly",
  },
  {
    prefix: "/api/billing/webhook",
    reason: "Stripe-signed; unreachable from a browser session",
  },
  {
    prefix: "/api/health",
    reason: "deliberately unauthenticated liveness probe, holds no tenant data",
  },
];

/**
 * WRITABLE routes knowingly left out of the attack, named exactly, one reason
 * each. The bar for an entry here is a sentence that says why a signed-in tenant
 * cannot use this route to reach ANOTHER tenant's data — not merely why it is
 * awkward to test.
 *
 * Adding a route here is the reviewed decision. Adding a writable route WITHOUT
 * either attacking it or listing it here fails
 * tests/unit/isolation-route-coverage.test.ts.
 */
export const WRITABLE_ROUTE_EXEMPTIONS: { path: string; reason: string }[] = [
  {
    path: "/api/auth/[...nextauth]",
    reason:
      "NextAuth's own handler. Signing in through it is HOW the attack obtains its tenant-A " +
      "session, so it is exercised on every run; posting to it with a foreign tenant's " +
      "identifier tests the auth library's own credential check, not this app's tenancy seam.",
  },
  {
    path: "/api/auth/signup",
    reason:
      "Unauthenticated by design: it CREATES an account and its tenant. A signed-in tenant-A " +
      "caller posting here makes a new tenant of their own — there is no existing tenant's " +
      "database for the write to reach. Its own authorization is covered by the auth suite.",
  },
  {
    path: "/api/auth/forgot-password",
    reason:
      "Unauthenticated by design and takes no tenant-scoped input: it writes a reset token for " +
      "the address supplied and nothing else, so there is no other tenant's row for it to touch.",
  },
  {
    path: "/api/billing/webhook",
    reason:
      "Stripe-signed. A browser session cannot forge the signature, so the cross-tenant attack " +
      "cannot reach it at all; its tenant handling is covered by the billing webhook unit tests.",
  },
];

/**
 * The HTTP verbs a `route.ts` exports.
 *
 * Next.js routes a request to the named export matching its method, and there are
 * three shapes an app uses to provide one:
 *
 *   export async function POST(...)        — the ordinary handler
 *   export const POST = ...                — a wrapped or generated handler
 *   export const { GET, POST } = handlers  — NextAuth's own shape
 *
 * All three are read here. Comments are stripped first, so a commented-out
 * handler (or a doc comment that merely mentions DELETE, which the settings route
 * has) is not mistaken for a live one.
 */
export function exportedMethods(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments, but not the `//` inside a `https://` URL.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const found = new Set<string>();
  const verbs = ROUTE_EXPORT_VERBS.join("|");

  for (const m of code.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${verbs})\\b`, "g"),
  )) {
    found.add(m[1]);
  }
  for (const m of code.matchAll(
    new RegExp(`export\\s+(?:const|let|var)\\s+(${verbs})\\s*[:=]`, "g"),
  )) {
    found.add(m[1]);
  }
  // Destructured or aliased export lists: `export const { GET, POST } = x` and
  // `export { handler as POST }`. The exported NAME is what Next.js routes on,
  // so an alias is read from the right-hand side of `as`.
  for (const m of code.matchAll(
    /export\s+(?:const|let|var)?\s*\{([^}]*)\}/g,
  )) {
    for (const part of m[1].split(",")) {
      const name = part.includes(" as ")
        ? part.split(" as ")[1]
        : part.split(":")[0];
      const clean = name.trim();
      if ((ROUTE_EXPORT_VERBS as readonly string[]).includes(clean)) {
        found.add(clean);
      }
    }
  }

  return [...found].sort();
}

/**
 * Every route under `app/`, with NOTHING removed.
 *
 * Next.js App Router: a directory holding `page.tsx` is a page route and one
 * holding `route.ts` is an API route; `(group)` and `@slot` directories are not
 * URL segments. `[dynamic]` segments are KEPT, with their parameter names, so
 * the caller can substitute a real record id (see per-tenant.spec.ts).
 */
export function discoverAllRoutes(appDir: string): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  function walk(dir: string, urlPath: string, params: string[]) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name);
    const isApi = names.includes("route.ts");
    if (names.includes("page.tsx") || isApi) {
      const file = isApi ? join(dir, "route.ts") : null;
      let methods: string[] = [];
      if (file) {
        try {
          methods = exportedMethods(readFileSync(file, "utf8"));
        } catch {
          methods = [];
        }
      }
      found.push({
        path: urlPath === "" ? "/" : urlPath,
        params: [...params],
        kind: isApi ? "api" : "page",
        file,
        methods,
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith("_")) continue;
      const isDynamic = name.startsWith("[");
      const segment =
        !isDynamic && (name.startsWith("(") || name.startsWith("@"))
          ? ""
          : `/${name}`;
      // `[id]`, `[...slug]` and `[[...slug]]` all name one parameter.
      const param = isDynamic
        ? name.replace(/^\[+\.{0,3}/, "").replace(/\]+$/, "")
        : null;
      walk(
        join(dir, name),
        urlPath + segment,
        param ? [...params, param] : params,
      );
    }
  }

  walk(appDir, "", []);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The exclusion entry that removes this path from the attack, or null. */
export function exclusionFor(
  path: string,
): { prefix: string; reason: string } | null {
  return (
    ROUTE_EXCLUSIONS.find(
      (e) => path === e.prefix || path.startsWith(`${e.prefix}/`),
    ) ?? null
  );
}

/** True when this route exports at least one verb that can modify data. */
export function isWritable(route: DiscoveredRoute): boolean {
  return route.methods.some((m) =>
    (WRITE_VERBS as readonly string[]).includes(m),
  );
}

/**
 * The routes the attack aims at: everything under `app/` except `/` and the
 * declared exclusions. Byte-for-byte the list the attack computed for itself
 * before this file existed.
 */
export function attackableRoutes(appDir: string): DiscoveredRoute[] {
  return discoverAllRoutes(appDir)
    .filter((route) => route.path !== "/")
    .filter((route) => exclusionFor(route.path) === null);
}

/** `app/` as this process sees it. */
export function appDir(): string {
  return join(process.cwd(), "app");
}
