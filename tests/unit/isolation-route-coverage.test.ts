// Isolation coverage guard (item 16a) — "every writable route is attacked" is
// asserted here rather than remembered.
//
// WHAT THIS PROTECTS
// ------------------
// tests/isolation/per-tenant.spec.ts mounts the cross-tenant attack against
// routes it DISCOVERS under `app/`, so a new route is attacked automatically and
// there is no target list to keep in step. The hole was the other direction: a
// writable route placed under one of the declared exclusions disappeared from
// discovery silently. Nothing failed, nothing was reported, and the route stayed
// unattacked until somebody noticed.
//
// So this file compares the two lists that actually matter:
//
//   every WRITABLE route under `app/`   (a route.ts exporting POST/PUT/PATCH/DELETE)
//   against
//   the routes the attack will reach    (attackableRoutes(), the same function the
//                                        attack itself calls)
//
// and requires the difference to be DECLARED, exactly, with a reason, in
// WRITABLE_ROUTE_EXEMPTIONS. A writable route that is neither attacked nor
// exempted fails this test with the two ways to fix it.
//
// WHY A UNIT TEST AND NOT PART OF THE PLAYWRIGHT SUITE
// ----------------------------------------------------
// This reads the source tree and nothing else: no server, no browser, no tenant
// databases. That means it runs EVERYWHERE — including on house-starter itself,
// where the attack self-skips because the template provisions no tenants. The
// template is where new routes are added, so the template is where the guard has
// to bite. Keeping it out of tests/isolation/ also keeps it out of the SEC.24
// isolation-floor's evidence: a test that always runs must never be mistakable
// for proof that the attack ran.

import { describe, expect, it } from "vitest";
import {
  ATTACKED_METHODS,
  ROUTE_EXCLUSIONS,
  WRITABLE_ROUTE_EXEMPTIONS,
  WRITE_VERBS,
  appDir,
  attackableRoutes,
  discoverAllRoutes,
  exclusionFor,
  exportedMethods,
  isWritable,
} from "../isolation/route-map";

const ALL = discoverAllRoutes(appDir());
const ATTACKED = attackableRoutes(appDir());
const ATTACKED_PATHS = new Set(ATTACKED.map((r) => r.path));

/** Every route that can modify data, attacked or not. */
const WRITABLE = ALL.filter(isWritable);

const EXEMPT = new Map(WRITABLE_ROUTE_EXEMPTIONS.map((e) => [e.path, e]));

/** What a developer has to do, said once and quoted by the failures below. */
const HOW_TO_FIX =
  "\n\nWHAT TO DO WHEN YOU ADD A WRITABLE ROUTE:\n" +
  "  Normally NOTHING — a new route.ts under app/ is discovered and attacked on the next\n" +
  "  isolation run with no change to any test. You only land here when the route sits under\n" +
  "  a prefix in ROUTE_EXCLUSIONS (tests/isolation/route-map.ts), which removes it from the\n" +
  "  attack. Then choose one, deliberately:\n" +
  "    (a) let it be attacked — narrow or remove the ROUTE_EXCLUSIONS prefix that covers it; or\n" +
  "    (b) exempt it — add { path, reason } to WRITABLE_ROUTE_EXEMPTIONS, where `reason` says\n" +
  "        why a signed-in tenant cannot use this route to reach ANOTHER tenant's data.\n" +
  '  "It is hard to test" is not a reason. An exemption is a claim about the boundary.';

describe("isolation attack route coverage", () => {
  it("discovers routes to attack at all", () => {
    // The vacuity check. An empty app/ (or a discovery walk that has stopped
    // working) would make every assertion below pass by finding nothing.
    expect(
      ALL.length,
      "no routes were discovered under app/ — route discovery is broken, and " +
        "with it every isolation assertion that depends on it",
    ).toBeGreaterThan(0);
    expect(
      WRITABLE.length,
      "no route under app/ exports POST, PUT, PATCH or DELETE. If that is true " +
        "the app writes nothing over HTTP; far more likely route discovery or " +
        "export detection has broken.",
    ).toBeGreaterThan(0);
  });

  it("attacks every writable route, or exempts it by name with a reason", () => {
    const uncovered = WRITABLE.filter(
      (r) => !ATTACKED_PATHS.has(r.path) && !EXEMPT.has(r.path),
    ).map((r) => {
      const excluded = exclusionFor(r.path);
      return (
        `  ${r.path}  [${r.methods.join(", ")}]` +
        (excluded
          ? `  — removed from the attack by ROUTE_EXCLUSIONS prefix "${excluded.prefix}"`
          : "  — removed from the attack, but no exclusion prefix matches it (report this: " +
            "discovery and exclusion disagree)")
      );
    });

    expect(
      uncovered,
      "these routes can MODIFY DATA and the cross-tenant attack never reaches them, " +
        "so nothing proves a signed-in tenant cannot use them against another tenant:\n" +
        uncovered.join("\n") +
        HOW_TO_FIX,
    ).toEqual([]);
  });

  it("keeps every writable-route exemption honest and current", () => {
    const problems: string[] = [];

    for (const entry of WRITABLE_ROUTE_EXEMPTIONS) {
      const route = ALL.find((r) => r.path === entry.path);
      if (!route) {
        problems.push(
          `  ${entry.path} — exempted, but no such route exists under app/ any more. ` +
            "Delete the exemption; a stale one silently blesses whatever is added at that path next.",
        );
        continue;
      }
      if (!isWritable(route)) {
        problems.push(
          `  ${entry.path} — exempted as writable, but it exports only [${route.methods.join(", ") || "nothing"}]. ` +
            "Read-only routes need no exemption; delete it.",
        );
      }
      if (ATTACKED_PATHS.has(route.path)) {
        problems.push(
          `  ${entry.path} — exempted, but the attack reaches it anyway (no ROUTE_EXCLUSIONS ` +
            "prefix covers it). The exemption is doing nothing except hiding the next real one; delete it.",
        );
      }
      if (!entry.reason || entry.reason.trim().length < 20) {
        problems.push(
          `  ${entry.path} — exempted with no usable reason. State why a signed-in tenant ` +
            "cannot use this route to reach another tenant's data.",
        );
      }
    }

    expect(
      problems,
      "WRITABLE_ROUTE_EXEMPTIONS (tests/isolation/route-map.ts) has rotted:\n" +
        problems.join("\n"),
    ).toEqual([]);
  });

  it("keeps every exclusion prefix current and reasoned", () => {
    const problems: string[] = [];

    for (const entry of ROUTE_EXCLUSIONS) {
      if (!entry.reason || entry.reason.trim().length < 20) {
        problems.push(
          `  ${entry.prefix} — excluded with no usable reason. Say why the attack landing ` +
            "here would prove nothing.",
        );
      }
      const matches = ALL.filter(
        (r) => r.path === entry.prefix || r.path.startsWith(`${entry.prefix}/`),
      );
      if (matches.length === 0) {
        problems.push(
          `  ${entry.prefix} — excludes nothing: no route under app/ matches it. Delete it. ` +
            "A prefix kept past the routes it was written for is a trapdoor for whatever is " +
            "added under that path later.",
        );
      }
    }

    expect(
      problems,
      "ROUTE_EXCLUSIONS (tests/isolation/route-map.ts) has rotted:\n" +
        problems.join("\n"),
    ).toEqual([]);
  });

  it("attacks every write verb the attacked routes actually export", () => {
    // The other half of coverage. Reaching a route with the wrong verbs is not
    // reaching it: PUT /api/settings/[key] was attacked for years while its
    // DELETE — same handler file, same data, same authorization question — was
    // not (item 16b). This asserts the verb sets, not just the paths.
    const attackedVerbs = new Set(ATTACKED_METHODS as readonly string[]);
    const missing = new Map<string, string[]>();

    for (const route of ATTACKED) {
      const uncovered = route.methods.filter(
        (m) =>
          (WRITE_VERBS as readonly string[]).includes(m) &&
          !attackedVerbs.has(m),
      );
      if (uncovered.length > 0) missing.set(route.path, uncovered);
    }

    expect(
      [...missing].map(([path, verbs]) => `  ${path} — ${verbs.join(", ")}`),
      "these routes export a write verb the isolation attack never issues, so that " +
        "verb's authorization is untested against another tenant's data:\n" +
        [...missing].map(([p, v]) => `  ${p} — ${v.join(", ")}`).join("\n") +
        "\n\nFIX: attack the verb. WRITE_METHODS (sentinel leg) and DELETE_METHOD " +
        "(survive-check leg) in tests/isolation/route-map.ts are what ATTACKED_METHODS " +
        "is built from; adding a verb means giving it a leg in per-tenant.spec.ts that " +
        "can prove a leak, not just issuing the request.",
    ).toEqual([]);
  });
});

describe("route export detection", () => {
  // exportedMethods() is what "writable" means above, so it is asserted against
  // the shapes real route files use rather than trusted.
  it("reads the three export shapes Next.js routes on", () => {
    expect(exportedMethods("export async function POST(req: Request) {}")).toEqual(["POST"]);
    expect(exportedMethods("export function GET() {}")).toEqual(["GET"]);
    expect(exportedMethods("export const PATCH = handler;")).toEqual(["PATCH"]);
    expect(exportedMethods("export const { GET, POST } = handlers;")).toEqual(["GET", "POST"]);
    expect(exportedMethods("export { handler as DELETE };")).toEqual(["DELETE"]);
  });

  it("does not mistake a comment for a handler", () => {
    expect(
      exportedMethods("// export async function DELETE() {}\nexport async function PUT() {}"),
    ).toEqual(["PUT"]);
    expect(
      exportedMethods("/* PUT/DELETE — write or clear a value */\nexport async function GET() {}"),
    ).toEqual(["GET"]);
  });

  it("is not confused by a URL in the source", () => {
    expect(
      exportedMethods('const u = "https://example.test/x";\nexport async function POST() {}'),
    ).toEqual(["POST"]);
  });
});
