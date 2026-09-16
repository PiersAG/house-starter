// The three /api/auth/mfa/* routes (SEC.15, Slice 1), driven through their REAL
// handlers against a migrated in-memory catalog and the real in-memory limiter.
//
// What is being proven, beyond "it works":
//   • every route refuses without a signed-in account, before any work;
//   • every route is rate limited per client AND per account;
//   • input is validated, and the first problem is reported in plain words;
//   • nothing that carries a secret or a code can be cached;
//   • a missing encryption key is a clear 503, never a crash;
//   • NO MFA route touches tenant context — tenant-context is mocked with
//     functions that throw, and asserted never called.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { resetRateLimiterForTests } from "@/lib/rate-limit";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";
import { userMfaTotp } from "@/lib/schema";
import { TOTP_PERIOD_SECONDS } from "@/lib/mfa/totp";

const holder = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
}));

vi.mock("@/lib/auth", () => ({ auth: async () => holder.session }));
vi.mock("@/lib/catalog", () => ({
  get catalogDb() {
    return holder.db;
  },
  getCatalogDb: () => holder.db,
}));
vi.mock("@/lib/branding", () => ({ getAppName: async () => "Test App" }));

const tenant = vi.hoisted(() => {
  const boom = () => {
    throw new Error("an MFA route touched tenant context");
  };
  return {
    currentTenantId: vi.fn(boom),
    requireTenantId: vi.fn(boom),
    getTenantDb: vi.fn(boom),
  };
});
vi.mock("@/lib/tenant-context", () => ({
  SHARED_TENANT_ID: "__shared__",
  ...tenant,
}));

// Imported after the mocks are registered.
import { POST as enrollPOST } from "@/app/api/auth/mfa/enroll/route";
import { POST as confirmPOST } from "@/app/api/auth/mfa/confirm/route";
import { POST as verifyPOST } from "@/app/api/auth/mfa/verify/route";

type Handler = (request: Request) => Promise<Response>;

const ROUTES: { name: string; handler: Handler; limit: number }[] = [
  { name: "enroll", handler: enrollPOST, limit: AUTH_RATE_LIMITS.mfaEnroll.limit },
  { name: "confirm", handler: confirmPOST, limit: AUTH_RATE_LIMITS.mfaVerify.limit },
  { name: "verify", handler: verifyPOST, limit: AUTH_RATE_LIMITS.mfaVerify.limit },
];

let db: AppDatabase;
let userId: string;

beforeEach(async () => {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  db = drizzle(c) as AppDatabase;
  holder.db = db;
  userId = (await createUser(db, { email: "owner@example.com", passwordHash: "hash" })).id;
  holder.session = { user: { id: userId, email: "owner@example.com" } };
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.VERCEL_ENV;
  resetRateLimiterForTests();
});

afterEach(() => {
  expect(tenant.currentTenantId).not.toHaveBeenCalled();
  expect(tenant.requireTenantId).not.toHaveBeenCalled();
  expect(tenant.getTenantDb).not.toHaveBeenCalled();
  delete process.env.MFA_ENCRYPTION_KEY;
  delete process.env.RATE_LIMIT_ALLOW_IN_MEMORY;
  resetRateLimiterForTests();
});

let ipCounter = 0;
/** A POST with a JSON (or raw) body, from a fresh client address by default. */
function post(
  path: string,
  body: unknown,
  opts: { ip?: string; raw?: boolean } = {},
): Request {
  ipCounter += 1;
  return new Request(`http://localhost/api/auth/mfa/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    },
    body: opts.raw ? (body as string) : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function enroll(): Promise<string> {
  const res = await enrollPOST(post("enroll", {}));
  expect(res.status).toBe(200);
  return (await json(res)).secret as string;
}

function codeAt(secret: string, offsetSteps = 0): Promise<string> {
  const epoch = Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS;
  return generate({ secret, epoch });
}

/** Enroll and confirm through the routes; returns the secret and recovery codes. */
async function enrolledAndConfirmed(): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secret = await enroll();
  const res = await confirmPOST(post("confirm", { code: await codeAt(secret) }));
  expect(res.status).toBe(200);
  return { secret, recoveryCodes: (await json(res)).recoveryCodes as string[] };
}

describe.each(ROUTES)("POST /api/auth/mfa/$name — the shared gate", ({ name, handler, limit }) => {
  it("401 with no session", async () => {
    holder.session = null;
    const res = await handler(post(name, {}));
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("401 with a session that carries no account id", async () => {
    holder.session = { user: {} };
    expect((await handler(post(name, {}))).status).toBe(401);
  });

  it("400 on a body that is not JSON", async () => {
    const res = await handler(post(name, "not json{", { raw: true }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Request body must be valid JSON.");
  });

  it("429 per CLIENT — different accounts, one address", async () => {
    let last: Response | undefined;
    for (let i = 0; i <= limit; i += 1) {
      const id = (await createUser(db, { email: `u${i}@example.com`, passwordHash: "h" })).id;
      holder.session = { user: { id, email: `u${i}@example.com` } };
      last = await handler(post(name, { bad: true }, { ip: "203.0.113.1" }));
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(last!.headers.get("Cache-Control")).toBe("no-store");
  });

  it("429 per ACCOUNT — one account, rotating addresses", async () => {
    let last: Response | undefined;
    for (let i = 0; i <= limit; i += 1) {
      last = await handler(post(name, { bad: true }, { ip: `198.51.100.${i + 1}` }));
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/mfa/enroll", () => {
  it("400 with the validation message on unexpected input", async () => {
    const res = await enrollPOST(post("enroll", { extra: 1 }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/extra/);
  });

  it("200 with the secret, the otpauth URI and a QR code — never cached", async () => {
    const res = await enrollPOST(post("enroll", {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await json(res);
    expect(body.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(decodeURIComponent(body.otpauthUri as string)).toContain("owner@example.com");
    expect(body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    // Stored UNCONFIRMED — enrolling alone never turns MFA on.
    const [row] = await db.select().from(userMfaTotp).where(eq(userMfaTotp.userId, userId)).all();
    expect(row.confirmedAt).toBeNull();
    expect(row.secretCiphertext).not.toContain(body.secret as string);
  });

  it("labels the account with its id when the session has no email", async () => {
    holder.session = { user: { id: userId } };
    const body = await json(await enrollPOST(post("enroll", {})));
    expect(decodeURIComponent(body.otpauthUri as string)).toContain(userId);
  });

  it("409 once two-step verification is already on", async () => {
    await enrolledAndConfirmed();
    expect((await enrollPOST(post("enroll", {}))).status).toBe(409);
  });

  it("503 when the server has no encryption key", async () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    const res = await enrollPOST(post("enroll", {}));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /api/auth/mfa/confirm", () => {
  it("400 with the plain-English message when the code is missing or malformed", async () => {
    for (const body of [{}, { code: "abc" }, { code: 123456 }]) {
      const res = await confirmPOST(post("confirm", body));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe(
        "Enter the 6-digit code from your authenticator app.",
      );
    }
  });

  it("409 when set-up was never started", async () => {
    expect((await confirmPOST(post("confirm", { code: "123456" }))).status).toBe(409);
  });

  it("400 on a wrong code, and MFA stays off", async () => {
    const secret = await enroll();
    const wrong = String((Number(await codeAt(secret)) + 1) % 1_000_000).padStart(6, "0");
    expect((await confirmPOST(post("confirm", { code: wrong }))).status).toBe(400);
    const [row] = await db.select().from(userMfaTotp).where(eq(userMfaTotp.userId, userId)).all();
    expect(row.confirmedAt).toBeNull();
  });

  it("200 with ten recovery codes, accepting a spaced code — never cached", async () => {
    const secret = await enroll();
    const code = await codeAt(secret);
    const res = await confirmPOST(post("confirm", { code: `${code.slice(0, 3)} ${code.slice(3)}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await json(res);
    expect(body.recoveryCodes).toHaveLength(10);
  });

  it("409 when already active", async () => {
    const { secret } = await enrolledAndConfirmed();
    const res = await confirmPOST(post("confirm", { code: await codeAt(secret, 1) }));
    expect(res.status).toBe(409);
  });

  it("503 when the server has no encryption key", async () => {
    await enroll();
    delete process.env.MFA_ENCRYPTION_KEY;
    expect((await confirmPOST(post("confirm", { code: "123456" }))).status).toBe(503);
  });
});

describe("POST /api/auth/mfa/verify", () => {
  it("400 with the validation message on a missing or wrong-length code", async () => {
    const missing = await verifyPOST(post("verify", {}));
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toBe("Enter a code.");
    const short = await verifyPOST(post("verify", { code: "123" }));
    expect(short.status).toBe(400);
    expect((await json(short)).error).toBe(
      "Enter the 6-digit code from your app, or a recovery code.",
    );
  });

  it("409 when the account has no active factor", async () => {
    expect((await verifyPOST(post("verify", { code: "123456" }))).status).toBe(409);
  });

  it("200 for a fresh authenticator code, 400 when the same code is replayed", async () => {
    const { secret } = await enrolledAndConfirmed();
    const code = await codeAt(secret, 1);
    const ok = await verifyPOST(post("verify", { code }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await json(ok)).toEqual({ verified: true, method: "totp" });
    expect((await verifyPOST(post("verify", { code }))).status).toBe(400);
  });

  it("200 for a recovery code, exactly once", async () => {
    const { recoveryCodes } = await enrolledAndConfirmed();
    const first = await verifyPOST(post("verify", { code: recoveryCodes[0] }));
    expect(await json(first)).toEqual({ verified: true, method: "recovery_code" });
    expect((await verifyPOST(post("verify", { code: recoveryCodes[0] }))).status).toBe(400);
  });

  it("403 once the failure ceiling is reached", async () => {
    const { secret } = await enrolledAndConfirmed();
    await db
      .update(userMfaTotp)
      .set({ failedAttempts: 100 })
      .where(eq(userMfaTotp.userId, userId))
      .run();
    const res = await verifyPOST(post("verify", { code: await codeAt(secret, 1) }));
    expect(res.status).toBe(403);
  });

  it("503 when the key is missing and an authenticator code is sent", async () => {
    const { secret } = await enrolledAndConfirmed();
    delete process.env.MFA_ENCRYPTION_KEY;
    const res = await verifyPOST(post("verify", { code: await codeAt(secret, 1) }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
