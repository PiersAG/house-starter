// Shared-mode isolation spec (stage0-tenant-isolation, opt-in mode).
//
// PROVISIONS: one shared libSQL database. SEEDS sentinel rows for users A and B
// in the SAME database. Authenticates as user A; requests every data route;
// asserts no response contains user B's sentinels. This is the original
// ticket's test — the WHERE-clause defence that shared-mode apps depend on.
//
// BUILDER: fill TODO_ROUTES with the app's real data routes.

import { expect, test } from "@playwright/test";

test.skip(
  (process.env.TENANCY_MODE ?? "per_tenant").toLowerCase() !== "shared",
  "shared isolation spec runs only when TENANCY_MODE=shared",
);

const USER_A_SENTINEL = "SENTINEL-USER-A-77a91f";
const USER_B_SENTINEL = "SENTINEL-USER-B-c48d20";

const TODO_ROUTES: string[] = [
  // e.g. "/api/notes", "/api/records"
];

test.describe("shared-mode cross-user isolation", () => {
  test("no data route returns another user's sentinels", async ({ request }) => {
    test.skip(
      TODO_ROUTES.length === 0,
      "TODO_ROUTES is empty — the builder scaffolds the app's real data routes here",
    );

    // Builder implements seedUsers() and loginAs() against the app's real
    // schema. Both live under tests/isolation/support/ in the descendant app.
    // await seedUsers({ userA: USER_A_SENTINEL, userB: USER_B_SENTINEL });
    // await loginAs(request, { email: "a@example.test" });

    for (const route of TODO_ROUTES) {
      const response = await request.get(route);
      const body = await response.text();
      expect(body, `route ${route} leaked user B's sentinel`).not.toContain(
        USER_B_SENTINEL,
      );
    }
  });
});
