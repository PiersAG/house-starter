// Drizzle Kit configuration — used by the db:generate / db:migrate / db:push
// scripts to talk to the database.
//
// Dialect is "turso" (libSQL). The same config works for both dev and prod —
// only the DATABASE_URL value differs:
//   • dev:  DATABASE_URL=file:local.db        (local file, no auth token)
//   • prod: DATABASE_URL=libsql://<host>...   (hosted libSQL/Turso, with token)
//
// drizzle-kit does NOT auto-load .env.local (that is a Next.js runtime feature,
// not a drizzle-kit one), so we load it explicitly here. Without this, any
// db:* command would see DATABASE_URL as undefined.

import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load dev env if present; in CI/prod the vars are already in the environment.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:local.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
