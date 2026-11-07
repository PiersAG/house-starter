// The catalog DDL for the billable-action event table (lib/usage/billable-events.ts;
// app-business-core issue 808), kept beside the code that uses it and appended to
// CATALOG_MIGRATION_SQL (lib/migrate.ts). Idempotent, like the rest of the migration.
// Kept in sync with lib/schema.ts billableEvents.

export const USAGE_CATALOG_SQL = `
CREATE TABLE IF NOT EXISTS billable_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS billable_events_user_action_idx ON billable_events(user_id, action, occurred_at);
`;
