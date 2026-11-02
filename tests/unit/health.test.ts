import { describe, expect, it } from "vitest";
import { assembleHealth, type HealthDeps } from "@/lib/health/checks";

const base = {
  now: () => 1_700_000_000_000,
  env: {
    APP_LIFECYCLE_STATE: "LIVE_EVAL",
    VERCEL_GIT_COMMIT_SHA: "abc123",
  } as unknown as NodeJS.ProcessEnv,
} satisfies Pick<HealthDeps, "now" | "env">;

describe("assembleHealth", () => {
  it("is ok when the database ping succeeds", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 2,
    });
    expect(r.status).toBe("ok");
    expect(r.recent_errors_1h).toBe(2);
    expect(r.checks.find((c) => c.name === "database")?.ok).toBe(true);
    expect(r.lifecycle_state).toBe("LIVE_EVAL");
    expect(r.commit).toBe("abc123");
    expect(r.time).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("is degraded (503-driving) when the database ping reports not-ok", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: false, detail: "connection refused" }),
      errorCountSince: async () => 0,
    });
    expect(r.status).toBe("degraded");
    expect(r.checks.find((c) => c.name === "database")?.detail).toBe("connection refused");
  });

  it("treats a thrown DB ping as a failed critical check, not a crash", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => {
        throw new Error("boom");
      },
      errorCountSince: async () => 0,
    });
    expect(r.status).toBe("degraded");
    // Issue 444: the public answer carries a fixed reason, never the thrown text.
    expect(r.checks.find((c) => c.name === "database")?.detail).toBe("database check failed");
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  it("keeps recent-errors informational — a count failure does not degrade a healthy app", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => {
        throw new Error("count unavailable");
      },
    });
    expect(r.status).toBe("ok");
    expect(r.recent_errors_1h).toBeNull();
  });

  it("reports nulls for unset lifecycle/commit env", async () => {
    const r = await assembleHealth({
      now: () => 0,
      env: {} as unknown as NodeJS.ProcessEnv,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
    });
    expect(r.lifecycle_state).toBeNull();
    expect(r.commit).toBeNull();
  });

  it("reports slow requests in the last hour when the count is wired (#503)", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      slowRequestCountSince: async () => 4,
    });
    expect(r.slow_requests_1h).toBe(4);
    const unknown = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      slowRequestCountSince: async () => {
        throw new Error("no table");
      },
    });
    expect(unknown.slow_requests_1h).toBeNull();
    expect(unknown.status).toBe("ok");
  });

  it("tenant isolation (#806): passes with no cross-tenant access; an unreadable count is not a detection", async () => {
    const r = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      crossTenantCountSince: async () => 0,
    });
    expect(r.checks.find((c) => c.name === "tenant_isolation")).toMatchObject({ ok: true, critical: true });
    const unreadable = await assembleHealth({
      ...base,
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      crossTenantCountSince: async () => {
        throw new Error("down");
      },
    });
    expect(unreadable.status).toBe("ok");
  });

  // app-business-core issue 757: undelivered resets lock customers out, so a
  // bad sending setup or a complaint rate over its line drives the 503 the
  // outside uptime check alerts on.
  it("adds a critical email check, absent in log mode and never failing on a throw", async () => {
    const ok = { ...base, pingDb: async () => ({ ok: true }), errorCountSince: async () => 0 };
    const logMode = await assembleHealth({ ...ok, emailHealth: async () => null });
    expect(logMode.checks.find((c) => c.name === "email")).toBeUndefined();

    const red = await assembleHealth({
      ...ok,
      emailHealth: async () => ({ ok: false, detail: "spam complaint rate at or over 0.1% in 30 days" }),
    });
    expect(red.status).toBe("degraded");
    expect(red.checks.find((c) => c.name === "email")).toMatchObject({ ok: false, critical: true });

    const threw = await assembleHealth({
      ...ok,
      emailHealth: async () => {
        throw new Error("planted");
      },
    });
    expect(threw.status).toBe("ok");
  });
});

