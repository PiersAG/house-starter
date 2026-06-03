// Drizzle ORM client stub — wire to your database driver before use.
// DATABASE_URL is set in .env.local (see .env.example).
//
// Example with postgres.js:
//   import { drizzle } from "drizzle-orm/postgres-js";
//   import postgres from "postgres";
//   const client = postgres(process.env.DATABASE_URL!);
//   export const db = drizzle(client);
//
// See: https://orm.drizzle.team/docs/get-started

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: any = null; // replace with drizzle(client)
