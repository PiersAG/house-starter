// Catalog tables for running the app's hosting (app-business-core issues 358,
// 757 and 857), kept apart from lib/migrate.ts so that file stays within its
// length limit. Appended to CATALOG_MIGRATION_SQL there, so they are created and
// reconciled exactly like every other catalog table. Shapes: lib/schema.ts
// (tenantOrphans, emailEvents).

export const OPERATIONS_CATALOG_SQL = `
CREATE TABLE IF NOT EXISTS tenant_orphans (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('signup','erasure')),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cleared_at INTEGER
);

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  type TEXT NOT NULL CHECK (type IN ('sent','delivered','delayed','bounced','complained','failed','suppressed','other')),
  message_id TEXT,
  bounce_kind TEXT
);

CREATE INDEX IF NOT EXISTS email_events_received_idx ON email_events(received_at);
`;
