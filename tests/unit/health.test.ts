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
    expect(r.checks.find((c) => c.name === "database")?.detail).toBe("boom");
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
});
