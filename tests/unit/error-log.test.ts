import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordError,
  errorCountSince,
  sinkClient,
  __resetSinkForTests,
} from "@/lib/observability/error-log";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
const ORIGINAL_TOKEN = process.env.DATABASE_AUTH_TOKEN;

describe("error-log durable sink", () => {
  beforeEach(() => {
    __resetSinkForTests();
    // A shared in-memory libSQL DB for the process: the cached client keeps the
    // same connection across recordError + errorCountSince, so the row written
    // by one is visible to the other.
    process.env.DATABASE_URL = ":memory:";
    delete process.env.DATABASE_AUTH_TOKEN;
  });

  afterEach(() => {
    __resetSinkForTests();
    if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB_URL;
    if (ORIGINAL_TOKEN === undefined) delete process.env.DATABASE_AUTH_TOKEN;
    else process.env.DATABASE_AUTH_TOKEN = ORIGINAL_TOKEN;
  });

  it("persists a structured error and counts it", async () => {
    const ok = await recordError({
      message: "checkout failed",
      stack: "Error: checkout failed\n  at handler",
      route: "/api/billing/checkout",
      method: "POST",
      context: { statusCode: 500 },
    });
    expect(ok).toBe(true);

    const n = await errorCountSince(Date.now() - 3_600_000);
    expect(n).toBe(1);

    // Row is durable in the same connection and carries the structured fields.
    const client = sinkClient();
    const res = await client!.execute("SELECT message, route, method, context FROM error_events");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].message).toBe("checkout failed");
    expect(res.rows[0].route).toBe("/api/billing/checkout");
    expect(res.rows[0].context).toContain("500");
  });

  it("counts only events inside the window", async () => {
    await recordError({ message: "recent" });
    // A window that starts in the future excludes the just-written row.
    const n = await errorCountSince(Date.now() + 3_600_000);
    expect(n).toBe(0);
  });

  it("never throws and returns false when no sink is configured", async () => {
    __resetSinkForTests();
    delete process.env.DATABASE_URL;
    const ok = await recordError({ message: "no sink here" });
    expect(ok).toBe(false);
    // The count path is also safe with no sink.
    await expect(errorCountSince(Date.now() - 1000)).resolves.toBe(0);
  });
});
