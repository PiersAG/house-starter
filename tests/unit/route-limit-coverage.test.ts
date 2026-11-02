// @vitest-environment node
//
// Every route has a limit (app-business-core #787: "auth routes only; other
// endpoints are a one-line umbrella component" is the gap this closes). Read
// from the files themselves, so a route or server action a build adds without a
// limit fails here rather than shipping unlimited.
//
// A route handler file (app/**/route.ts) and a server-action file ("use server"
// at the top) must use lib/abuse/route-limit.ts. The only files allowed without
// it are listed below, each with its reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_LIMITS } from "@/config/rate-limits";

const ROOT = join(__dirname, "..", "..");

function files(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...files(rel, keep));
    else if (keep(name)) out.push(rel);
  }
  return out;
}

/**
 * Wired by the CEO script of dispatch AD (blocked/wire_api_routes.py), which
 * empties this list in the same step: the sign-in routes are the gate-protected
 * kernel, the billing routes the money path, and the others were being changed
 * by dispatch AC (request logging) when this landed. Nothing may be ADDED here.
 */
export const PENDING_CEO_WIRING: readonly string[] = [
];

/** Files that may stay without a route limit, and why. */
const EXEMPT: Record<string, string> = {
  // The inline "Sign out" action ends only the caller's own session; refusing it
  // would keep a person signed in against their wish.
  "app/dashboard/page.tsx": "sign-out only",
};

const USES_LIMIT = /from "@\/lib\/abuse\/route-limit"/;

describe("every route has a limit (#787)", () => {
  const routes = files("app", (n) => n === "route.ts");
  const actions = files("app", (n) => /\.(ts|tsx)$/.test(n)).filter((f) =>
    /^\s*["']use server["']/m.test(readFileSync(join(ROOT, f), "utf8")),
  );

  it("finds the routes and the server actions", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(actions.length).toBeGreaterThanOrEqual(4);
  });

  it.each([...routes, ...actions].filter((f) => !EXEMPT[f]))("%s uses a route limit", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    if (PENDING_CEO_WIRING.includes(file)) {
      // still waiting for the CEO script: it must not be half-wired
      expect(USES_LIMIT.test(src)).toBe(false);
      return;
    }
    expect(src).toMatch(USES_LIMIT);
    for (const m of src.matchAll(/(?:withRouteLimit|guardRouteAction)\(\s*"([^"]+)"/g)) {
      expect(Object.keys(ROUTE_LIMITS), `${file} names ${m[1]}`).toContain(m[1]);
    }
  });

  it("the pending list only ever shrinks: every entry is a real route file", () => {
    for (const f of PENDING_CEO_WIRING) expect(routes).toContain(f);
    expect(PENDING_CEO_WIRING.length).toBeLessThanOrEqual(13);
  });
});
