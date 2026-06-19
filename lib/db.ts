import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required — set it in .env.local");

const client = createClient({ url });
export const db = drizzle(client);
