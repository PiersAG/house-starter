// Instrumentation unit tests — two guarantees the boot hook must uphold:
//
//   1. Boot env validation is DETERMINISTIC: a variable the contract declares
//      deploy-injected but that is missing from the environment fails LOUDLY
//      at boot (register rejects), naming the missing var. A partial prod
//      environment must not become a per-request 500.
//
//   2. The cold-start migration must NEVER poison the instance. Live incident
//      (k9coach preview, 2026-07-16): instrumentation.register() ran a remote
//      Turso migration at every cold start; a transient `connect ETIMEDOUT`
//      made register() throw, Next.js marked the hook failed, and that
//      instance returned 500 for EVERY request. Pinned contract: a failed
//      migration is retried once, then logged — never re-thrown.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { migrateMock } = vi.hoisted(() => ({ migrateMock: vi.fn() }));

vi.mock("@/lib/migrate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/migrate")>();
  return { ...actual, migrate: migrateMock };
});

import {
  assertBootEnv,
  register,
  requiredBootEnv,
} from "@/instrumentation";

// The real repo-root contract, read once so assertBootEnv (pure) can be tested
// against exactly what validateBootEnv reads at boot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const REAL_CONTRACT = readFileSync(join(process.cwd(), ".env.contract"), "utf8");

// Every env var either the validator or the migration path reads. Saved and
// restored around each test so nothing leaks between cases.
const ENV_KEYS = [
  "NEXT_RUNTIME",
  "TENANCY_MODE",
  "DATABASE_URL",
  "DATABASE_AUTH_TOKEN",
  "AUTH_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "APP_LIFECYCLE_STATE",
  "RATE_LIMIT_ALLOW_IN_MEMORY",
  "EMAIL_PROVIDER_API_KEY",
  "EMAIL_SEND_MODE",
  "RATE_LIMIT_STORE_URL",
  "RATE_LIMIT_STORE_TOKEN",
  // Saved/restored explicitly because the rate-limit store's requirement is
  // conditional on it. A test run that inherited a stray VERCEL_ENV would
  // otherwise change what "a valid environment" means.
  "VERCEL_ENV",
] as const;
const saved: Record<string, string | undefined> = {};

/** Set every contract-required var to a valid throwaway value. */
function setFullValidEnv(): void {
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.TENANCY_MODE = "shared";
  process.env.DATABASE_URL = "libsql://preview-db.example.turso.io";
  process.env.DATABASE_AUTH_TOKEN = "test-token";
  process.env.AUTH_SECRET = "dummy-session-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
  process.env.APP_LIFECYCLE_STATE = "LIVE_EVAL";
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  process.env.EMAIL_PROVIDER_API_KEY = "re_dummy";
  process.env.EMAIL_SEND_MODE = "log";
  // NOT a deployed instance — the baseline every other test builds on. The
  // rate-limit store is contract-declared `secret` but required only when
  // VERCEL_ENV is set, so a local/CI environment is complete WITHOUT it.
  delete process.env.VERCEL_ENV;
  delete process.env.RATE_LIMIT_STORE_URL;
  delete process.env.RATE_LIMIT_STORE_TOKEN;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setFullValidEnv();
  migrateMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// requiredBootEnv — pure parser
// ---------------------------------------------------------------------------

describe("requiredBootEnv", () => {
  it("returns only deploy-injected names (secret/generated/fixed), ignoring infra/app/comments", () => {
    const contract = [
      "# a comment",
      "",
      "VERCEL_TOKEN=infra",
      "AUTH_SECRET=generated",
      "STRIPE_SECRET_KEY=secret",
      "TENANCY_MODE=fixed",
      "EMAIL_FROM=app",
      "malformed-line-without-equals",
    ].join("\n");
    expect(requiredBootEnv(contract).sort()).toEqual(
      ["AUTH_SECRET", "STRIPE_SECRET_KEY", "TENANCY_MODE"].sort(),
    );
  });

  it("tolerates trailing tokens after the source word", () => {
    expect(requiredBootEnv("DATABASE_URL=generated  # per-run preview DB")).toEqual([
      "DATABASE_URL",
    ]);
  });
});

// ---------------------------------------------------------------------------
// assertBootEnv — pure presence check against the real contract text
// ---------------------------------------------------------------------------

describe("assertBootEnv", () => {
  it("passes when every deploy-injected contract var is present", () => {
    expect(() => assertBootEnv(REAL_CONTRACT)).not.toThrow();
  });

  it("throws, naming the missing var, when a required var is absent", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => assertBootEnv(REAL_CONTRACT)).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("treats an empty-string value as missing", () => {
    process.env.APP_LIFECYCLE_STATE = "";
    expect(() => assertBootEnv(REAL_CONTRACT)).toThrow(/APP_LIFECYCLE_STATE/);
  });

  it("does NOT require DATABASE_AUTH_TOKEN for a local file: database", () => {
    process.env.DATABASE_URL = "file:local.db";
    delete process.env.DATABASE_AUTH_TOKEN;
    expect(() => assertBootEnv(REAL_CONTRACT)).not.toThrow();
  });

  it("DOES require DATABASE_AUTH_TOKEN for a remote libsql:// database", () => {
    process.env.DATABASE_URL = "libsql://remote.turso.io";
    delete process.env.DATABASE_AUTH_TOKEN;
    expect(() => assertBootEnv(REAL_CONTRACT)).toThrow(/DATABASE_AUTH_TOKEN/);
  });

  // The rate-limit store, same conditional shape as DATABASE_AUTH_TOKEN above.
  // Both halves matter: required on a deploy (or the fail-closed posture is
  // decoration), NOT required off one (or `npm run dev`, CI and the isolation
  // harness stop booting — the failure mode a naive `.env.contract` entry
  // would have caused).

  it("does NOT require the rate-limit store when VERCEL_ENV is unset (dev/CI/harness)", () => {
    delete process.env.VERCEL_ENV;
    delete process.env.RATE_LIMIT_STORE_URL;
    delete process.env.RATE_LIMIT_STORE_TOKEN;
    expect(() => assertBootEnv(REAL_CONTRACT)).not.toThrow();
  });

  it.each(["production", "preview"])(
    "DOES require the rate-limit store on a deployed instance (VERCEL_ENV=%s)",
    (vercelEnv) => {
      process.env.VERCEL_ENV = vercelEnv;
      delete process.env.RATE_LIMIT_STORE_URL;
      delete process.env.RATE_LIMIT_STORE_TOKEN;
      expect(() => assertBootEnv(REAL_CONTRACT)).toThrow(
        /RATE_LIMIT_STORE_URL[\s\S]*RATE_LIMIT_STORE_TOKEN/,
      );
    },
  );

  it("a deployed instance WITH the store set boots", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.RATE_LIMIT_STORE_URL = "https://redis.example.upstash.io";
    process.env.RATE_LIMIT_STORE_TOKEN = "token";
    expect(() => assertBootEnv(REAL_CONTRACT)).not.toThrow();
  });

  it("an EMPTY store URL on a deployed instance is missing, not satisfied", () => {
    process.env.VERCEL_ENV = "production";
    process.env.RATE_LIMIT_STORE_URL = "";
    process.env.RATE_LIMIT_STORE_TOKEN = "token";
    expect(() => assertBootEnv(REAL_CONTRACT)).toThrow(/RATE_LIMIT_STORE_URL/);
  });

  it("the contract DECLARES both store vars as deploy-injected", () => {
    // Guards the other half of the pairing: if someone downgrades these to
    // `app` in .env.contract, the conditional above silently stops applying and
    // this test says so.
    expect(requiredBootEnv(REAL_CONTRACT)).toContain("RATE_LIMIT_STORE_URL");
    expect(requiredBootEnv(REAL_CONTRACT)).toContain("RATE_LIMIT_STORE_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// register — env validation runs before migration; migration never poisons
// ---------------------------------------------------------------------------

describe("register — boot env validation is deterministic (fail loudly)", () => {
  it("rejects when a required env var is missing, and does not run the migration", async () => {
    delete process.env.AUTH_SECRET;
    await expect(register()).rejects.toThrow(/AUTH_SECRET/);
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it("does nothing at all in the edge runtime (validation is Node-only)", async () => {
    process.env.NEXT_RUNTIME = "edge";
    delete process.env.AUTH_SECRET; // would fail validation if it ran
    await expect(register()).resolves.toBeUndefined();
    expect(migrateMock).not.toHaveBeenCalled();
  });
});

describe("register — cold-start migration must never poison the instance", () => {
  it("runs the migration in shared mode once the env validates", async () => {
    migrateMock.mockResolvedValue(undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(migrateMock).toHaveBeenCalledWith(
      "libsql://preview-db.example.turso.io",
      "test-token",
    );
  });

  it("retries once on a transient failure, then succeeds", async () => {
    migrateMock
      .mockRejectedValueOnce(new Error("connect ETIMEDOUT 52.18.151.235:443"))
      .mockResolvedValueOnce(undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(migrateMock).toHaveBeenCalledTimes(2);
  });

  it("NEVER rejects even when both attempts fail — the instance keeps serving", async () => {
    migrateMock.mockRejectedValue(
      new Error("connect ETIMEDOUT 52.18.151.235:443"),
    );
    await expect(register()).resolves.toBeUndefined();
    expect(migrateMock).toHaveBeenCalledTimes(2);
  });

  it("does not run the migration in per-tenant mode (but still validates env)", async () => {
    process.env.TENANCY_MODE = "per_tenant";
    await expect(register()).resolves.toBeUndefined();
    expect(migrateMock).not.toHaveBeenCalled();
  });
});
