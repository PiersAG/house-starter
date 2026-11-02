// Bundle S13 schema: the event claim (#542) and the app's own billing record
// (#788, #753, #370) reach a fresh database AND one created before them.

import { describe, expect, it } from "vitest";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";

async function columns(
  c: ReturnType<typeof createMigrationDatabase>,
  table: string,
): Promise<string[]> {
  const r = await c.execute(`PRAGMA table_info(${table});`);
  return r.rows.map((row) => String((row as Record<string, unknown>).name));
}

describe("S13 tables", () => {
  it("a fresh database has the claim columns and both billing tables", async () => {
    const c = createMigrationDatabase(":memory:");
    await runMigrations(c);
    expect(await columns(c, "stripe_events")).toEqual([
      "id",
      "processed_at",
      "status",
      "claimed_at",
    ]);
    expect(await columns(c, "billing_invoices")).toContain(
      "dunning_emails_sent",
    );
    expect(await columns(c, "billing_disputes")).toContain("evidence_due_by");
    c.close();
  });

  it("an existing stripe_events table gains the columns, and its old rows count as finished", async () => {
    const c = createMigrationDatabase(":memory:");
    await c.execute(
      "CREATE TABLE stripe_events (id TEXT PRIMARY KEY NOT NULL, processed_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    );
    await c.execute("INSERT INTO stripe_events (id) VALUES ('evt_old')");
    await runMigrations(c);
    expect(await columns(c, "stripe_events")).toEqual([
      "id",
      "processed_at",
      "status",
      "claimed_at",
    ]);
    const r = await c.execute(
      "SELECT status, claimed_at FROM stripe_events WHERE id = 'evt_old'",
    );
    expect(r.rows[0]).toMatchObject({ status: "done", claimed_at: null });
    c.close();
  });

  it("a claim can only be 'processing' or 'done'", async () => {
    const c = createMigrationDatabase(":memory:");
    await runMigrations(c);
    await expect(
      c.execute(
        "INSERT INTO stripe_events (id, status) VALUES ('evt_x', 'maybe')",
      ),
    ).rejects.toThrow();
    c.close();
  });
});
