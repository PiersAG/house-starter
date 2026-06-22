// Drizzle ORM schema for the house-starter template.
//
// Pure table definitions only — importing this module has NO side effects
// (it never opens a database connection or runs a migration at load time).
// Application code and the migration logic both import these definitions.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Passwords are never stored in plain text — only an Argon2id/bcrypt hash.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Notes belong to exactly one user (ownership-only authorisation).
 * Each note has a title and a body — the entire product scope.
 */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
