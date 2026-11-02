// The catalog DDL for the session record (lib/session/records.ts; app-business-core
// issues 506, 519, 741), kept beside the code that uses it and spliced into
// CATALOG_MIGRATION_SQL (lib/migrate.ts) where revoked_sessions used to be written;
// revoked_sessions moved here with it, unchanged, beside the other session table. Idempotent,
// like the rest of the migration. Kept in sync with lib/schema.ts userSessions.

export const SESSION_CATALOG_SQL = `
CREATE TABLE IF NOT EXISTS revoked_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS revoked_sessions_jti_idx ON revoked_sessions(jti);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT,
  device_label TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  risk_score INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
`;
