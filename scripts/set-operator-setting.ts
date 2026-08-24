// scripts/set-operator-setting.ts — the CEO CLI for OPERATOR settings. This is
// the ONLY way an operator value is set, changed or cleared.
//
// It is a standalone script, NEVER imported by the app runtime — the same shape
// scripts/grant-access.ts uses, and for the same reason. The point is not that
// the app checks a privilege before writing these values; it is that the app has
// no path to them at all. A privilege check is a line of code that can be
// forgotten on the next route. An absent request path cannot be.
//
//   tsx scripts/set-operator-setting.ts list
//   tsx scripts/set-operator-setting.ts get billing.trial_period_days
//   tsx scripts/set-operator-setting.ts set billing.trial_period_days 30
//   tsx scripts/set-operator-setting.ts set core.app_name "K9Coach"
//   tsx scripts/set-operator-setting.ts clear billing.trial_period_days
//
// Targets the CATALOG via lib/catalog.ts::resolveCatalog — CATALOG_DATABASE_URL
// when set, DATABASE_URL otherwise. Operator values are control-plane rows, so
// this must never be pointed at a tenant database: a value written there would
// be invisible to the app, which reads operator scope from the catalog only.
//
// Values are validated against the key's own definition before any write —
// value_type, enum membership and numeric bounds — so a typo becomes a refusal
// with a plain message rather than a setting nothing can read back.
//
// Excluded from coverage (scripts/ is outside the coverage include), like
// scripts/migrate.ts and scripts/grant-access.ts.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { resolveCatalog } from "../lib/catalog";
import { ALL_DEFINITIONS, getDefinition } from "../lib/settings/registry";
import {
  getOperatorValue,
  setOperatorValue,
  deleteOperatorValue,
} from "../lib/settings/operator";
import { validateValue } from "../lib/settings/validation";
import type { AppDatabase } from "../lib/users";
import type { SettingDefinition } from "../lib/settings/types";

function connect(): AppDatabase {
  const { url, authToken } = resolveCatalog();
  const remote = /^(libsql|https?|wss?):/i.test(url);
  const client = createClient({ url, authToken: remote ? authToken : undefined });
  return drizzle(client) as AppDatabase;
}

/** Every key this CLI will touch — and nothing else. */
function operatorDefinitions(): SettingDefinition[] {
  return ALL_DEFINITIONS.filter((def) => def.operatorOnly === true);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Turn a command-line string into the value the definition expects.
 *
 * The shell hands over text and nothing else, so this is where "30" becomes the
 * number 30 and "true" becomes the boolean. Deliberately narrow, per value_type,
 * rather than a blanket JSON.parse: a blanket parse would silently turn the app
 * name "2026" into a number, and turn a JSON-looking string into an object.
 */
function coerce(def: SettingDefinition, raw: string): unknown {
  switch (def.valueType) {
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return fail(`${def.key}: expected true or false, got ${JSON.stringify(raw)}.`);
    case "integer":
    case "duration_hours":
    case "decimal": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return fail(`${def.key}: expected a number, got ${JSON.stringify(raw)}.`);
      }
      return n;
    }
    case "json":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return fail(`${def.key}: expected valid JSON, got ${JSON.stringify(raw)}.`);
      }
    // text and enum are already the right shape.
    default:
      return raw;
  }
}

/** `key` if it is an operator key; exits with an explanation if it is not. */
function requireOperatorKey(key: string | undefined): SettingDefinition {
  if (!key) fail("A setting key is required. Run `list` to see the operator keys.");
  const def = getDefinition(key);
  if (!def) fail(`Unknown setting "${key}". Run \`list\` to see the operator keys.`);
  if (def.operatorOnly !== true) {
    fail(
      `"${key}" is not an operator setting — it belongs to a customer of this ` +
        `app, who sets it themselves on the app's own settings page. This CLI ` +
        `writes control-plane values only. Run \`list\` to see them.`,
    );
  }
  return def;
}

async function main(): Promise<void> {
  const [, , cmd, key, ...rest] = process.argv;
  const db = connect();

  if (cmd === "list") {
    console.log("Operator settings (set here, and nowhere else):\n");
    for (const def of operatorDefinitions()) {
      const stored = await getOperatorValue(db, def.key);
      const inForce = stored === undefined ? def.factoryDefault : stored;
      const origin = stored === undefined ? "factory default" : "operator-set";
      console.log(`  ${def.key}`);
      console.log(`      ${def.label} — ${def.description}`);
      console.log(`      in force: ${JSON.stringify(inForce)}  (${origin})\n`);
    }
    return;
  }

  if (cmd === "get") {
    const def = requireOperatorKey(key);
    const stored = await getOperatorValue(db, def.key);
    if (stored === undefined) {
      console.log(
        `${def.key}: ${JSON.stringify(def.factoryDefault)} (factory default — no operator value set)`,
      );
    } else {
      console.log(`${def.key}: ${JSON.stringify(stored)} (operator-set)`);
    }
    return;
  }

  if (cmd === "set") {
    const def = requireOperatorKey(key);
    if (rest.length === 0) fail(`A value is required: set ${def.key} <value>`);
    const value = coerce(def, rest.join(" "));
    const validation = validateValue(def, value);
    if (!validation.ok) fail(`${def.key}: ${validation.message}`);
    await setOperatorValue(db, def.key, validation.value);
    console.log(`${def.key} set to ${JSON.stringify(validation.value)}.`);
    console.log("It applies on the next read — no deploy needed.");
    return;
  }

  if (cmd === "clear") {
    const def = requireOperatorKey(key);
    const removed = await deleteOperatorValue(db, def.key);
    console.log(
      removed
        ? `${def.key} cleared — it reverts to the factory default ${JSON.stringify(def.factoryDefault)}.`
        : `${def.key} had no operator value; it was already the factory default ${JSON.stringify(def.factoryDefault)}.`,
    );
    return;
  }

  fail(
    "Usage:\n" +
      "  tsx scripts/set-operator-setting.ts list\n" +
      "  tsx scripts/set-operator-setting.ts get   <key>\n" +
      "  tsx scripts/set-operator-setting.ts set   <key> <value>\n" +
      "  tsx scripts/set-operator-setting.ts clear <key>",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
