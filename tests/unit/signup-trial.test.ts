// Auto-trial on signup (step 6, Part B). Two layers:
//   1. startTrialForNewOwner directly — trial length from the registry, the
//      step-5 gate ALLOWS it, it EXPIRES (so the hard gate later applies), and
//      it never clobbers an existing subscription.
//   2. the REAL POST /api/auth/signup handler — a new account gets both a user
//      AND a trial, so the dashboard is reachable immediately (not paywalled).
//
// The catalog singleton and the rate limiter are mocked (route layer); the trial
// helper tests pass their db explicitly and are unaffected by the catalog mock.
// Tenant provisioning is NOT mocked — the signup paths must really create the
// new owner's database and register it, so these tests assert that too.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { Client } from "@libsql/client";
import { tenants, users as usersTable } from "@/lib/schema";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, getUserByEmail, type AppDatabase } from "@/lib/users";
import { setOwnerValue } from "@/lib/settings/values";
import {
  getSubscriptionByUserId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";
import { requireActiveSubscription } from "@/lib/billing/gate";
import { startTrialForNewOwner } from "@/lib/billing/trial";

const DAY = 86_400_000;
const NOW = new Date("2026-07-21T12:00:00Z");

// Provisioned tenant databases are real files; keep them out of the repo.
let tenantDir: string;
beforeAll(() => {
  tenantDir = mkdtempSync(join(tmpdir(), "house-starter-signup-tenants-"));
  process.env.TENANT_PROVISIONER = "file";
  process.env.TENANT_DB_DIR = tenantDir;
});
afterAll(() => {
  delete process.env.TENANT_PROVISIONER;
  delete process.env.TENANT_DB_DIR;
  rmSync(tenantDir, { recursive: true, force: true });
});

// Route-layer mocks. The trial-helper describe below passes its db explicitly,
// so this catalog mock only matters for the signup describes. Both the
// convenience proxy and the accessor are provided, because the provisioner uses
// the accessor and must write its tenant registration into the SAME database
// the route reads accounts from.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/catalog", () => ({
  get catalogDb() {
    return holder.db;
  },
  getCatalogDb: () => holder.db,
}));
vi.mock("@/lib/rate-limit", () => ({
  getRateLimiter: () => ({ hit: async () => ({ allowed: true }) }),
  clientKeyFromHeaders: () => "test-key",
}));
// Mock @/lib/auth so importing the signup server action does not load auth.config
// (which throws at import without AUTH_SECRET); signIn resolves without redirecting.
vi.mock("@/lib/auth", () => ({ signIn: vi.fn(async () => {}) }));
// The signup SERVER ACTION is throttled now (SEC.42), and a server action takes
// the client key from next/headers — which has no store outside a real request.
// Supplying one is what a unit test of a server action has to do; the throttle
// itself is tested in tests/unit/auth-rate-limit.test.ts.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

// Imported after the mocks are registered.
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { signupAction } from "@/app/signup/actions";

describe("startTrialForNewOwner", () => {
  let client: Client;
  let db: AppDatabase;
  let userId: string;

  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client); // seeds billing.trial_period_days (=14, kernel)
    db = drizzle(client) as AppDatabase;
    userId = (await createUser(db, { email: "o@test.example", passwordHash: "h" })).id;
  });
  afterEach(() => client.close());

  it("creates a trial the step-5 gate ALLOWS, at the factory-default 14 days", async () => {
    await startTrialForNewOwner(db, userId, { now: NOW });
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub).toBeTruthy();
    expect(sub?.trialEndsAt?.getTime()).toBe(NOW.getTime() + 14 * DAY);
    // Must expire via trialEndsAt, NOT sit in the permanently-allowed
    // active/trialing status.
    expect(["active", "trialing"]).not.toContain(sub?.status);
    // Dashboard reachable immediately.
    const gate = await requireActiveSubscription(db, userId, { now: NOW });
    expect(gate.allowed).toBe(true);
  });

  it("respects the owner-configured trial length (registry key)", async () => {
    await setOwnerValue(db, "billing.trial_period_days", 30);
    await startTrialForNewOwner(db, userId, { now: NOW });
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.trialEndsAt?.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it("EXPIRES — after trialEndsAt the step-5 gate blocks", async () => {
    await startTrialForNewOwner(db, userId, { now: NOW });
    const afterTrial = new Date(NOW.getTime() + 15 * DAY); // past the 14-day trial
    const gate = await requireActiveSubscription(db, userId, { now: afterTrial });
    expect(gate.allowed).toBe(false);
  });

  it("never clobbers an existing subscription (idempotent-safe)", async () => {
    await upsertSubscriptionByUserId(db, { userId, status: "active" });
    await startTrialForNewOwner(db, userId, { now: NOW });
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("active");
    expect(sub?.trialEndsAt ?? null).toBeNull();
  });
});

describe("POST /api/auth/signup — new owner is trialed, not instantly paywalled", () => {
  let client: Client;
  let db: AppDatabase;

  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
    holder.db = db;
  });
  afterEach(() => {
    client.close();
    vi.clearAllMocks();
  });

  it("creates the account AND a trial subscription; the gate allows access", async () => {
    const req = new Request("http://test/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@owner.test", password: "TestPass123!secure" }),
    });
    const res = await signupRoute(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();

    const sub = await getSubscriptionByUserId(db, body.id);
    expect(sub).toBeTruthy();
    expect(sub?.trialEndsAt).toBeTruthy();

    const gate = await requireActiveSubscription(db, body.id);
    expect(gate.allowed).toBe(true);

    // ADR-023: the account now has a tenant, and that tenant is registered in
    // the catalog. Without this the new owner would sign in to nothing.
    const [account] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.id))
      .all();
    expect(account.tenantId).toBeTruthy();
    const registered = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, account.tenantId!))
      .all();
    expect(registered).toHaveLength(1);
    expect(registered[0].provisioner).toBe("file");
  });
});

describe("signupAction (the UI signup path) — new owner is trialed", () => {
  // The SignupForm submits via this server action, NOT the API route, so the
  // trial must be created here too. This is the regression the E2E caught: an
  // action that registers-then-signs-in without a trial lands the owner on
  // /reactivate.
  let client: Client;
  let db: AppDatabase;

  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
    holder.db = db;
  });
  afterEach(() => {
    client.close();
    vi.clearAllMocks();
  });

  it("registers AND trials the owner; the gate allows the dashboard", async () => {
    const fd = new FormData();
    fd.set("email", "action@owner.test");
    fd.set("password", "TestPass123!secure");
    await signupAction(null, fd);

    const user = await getUserByEmail(db, "action@owner.test");
    expect(user).toBeTruthy();
    expect(user!.tenantId).toBeTruthy();
    const sub = await getSubscriptionByUserId(db, user!.id);
    expect(sub?.trialEndsAt).toBeTruthy();
    expect((await requireActiveSubscription(db, user!.id)).allowed).toBe(true);
  });
});
