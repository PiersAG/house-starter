// Everywhere personal data goes besides the databases: rate-limit counters, hosting
// logs, backups, analytics and sent emails (Matt Murphy #203). Split out of
// config/personal-data.ts, which re-exports it, to keep that file under the line limit.

import type { OutsideLocation } from "@/config/personal-data-types";

/** Everywhere else personal data goes (Matt Murphy #203: "backups, analytics and logs"). */
export const OUTSIDE_LOCATIONS: readonly OutsideLocation[] = [
  {
    id: "rate-limit-store",
    name: "Rate-limit counters",
    what: "Your IP address and account id, as request counters.",
    processors: ["upstash"],
    deletion:
      "Each counter expires on its own within 24 hours; nothing to delete.",
  },
  {
    id: "host-logs",
    name: "Hosting request logs",
    what: "Your IP address, the pages you open and when.",
    processors: ["vercel"],
    deletion: "Expire on their own within the hosting plan's log window.",
  },
  {
    id: "backups",
    name: "Database backups (point-in-time restore, and a nightly copy kept outside the database provider)",
    what: "A copy of the databases, for recovery after a fault.",
    processors: ["turso", "aws"],
    deletion:
      "Your own database's backups are deleted with it. The shared account database's backups age out within its restore window. The nightly outside copy is locked for 30 days and then deleted automatically, so it holds no erased account for longer than that. If any backup is ever restored, every account in the erasure ledger is deleted again before the app reopens (`npm run privacy:replay-erasures`, scripts/erasure-ledger.ts).",
  },
  {
    id: "analytics",
    name: "Analytics",
    what: "None: the app runs no analytics and loads no outside script (config/third-party.ts is empty).",
    processors: [],
    deletion:
      "Not applicable. An app that adds an analytics service lists it in config/third-party.ts with the personal data it reads; it then loads only after you agree, and its deletion route is recorded here.",
  },
  {
    id: "email",
    name: "Sent emails",
    what: "Your email address and the messages the app sends you.",
    processors: ["email"],
    deletion:
      "Resend keeps a record of each message for its plan's history window, then deletes it; the app keeps only delivery reports with no address or message (email_events, 90 days).",
  },
];
