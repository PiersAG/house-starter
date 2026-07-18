/**
 * Next.js instrumentation hook — runs once at server startup (Node.js runtime
 * only, not edge). Two responsibilities, in order:
 *
 *   1. Boot env validation — fail LOUDLY at boot if a variable the deploy is
 *      contracted to inject (.env.contract, source secret/generated/fixed) is
 *      missing from the running environment. Under the accepted D1 model a
 *      production deploy is a manual `vercel --prod` that bypasses
 *      safe-env-deploy's contract check entirely, so a missing production var
 *      would otherwise be rediscovered per-request as a 500. A deploy that dies
 *      immediately naming the missing var beats an instance that 500s forever.
 *      This is a DETERMINISTIC misconfiguration: throwing is correct.
 *
 *   2. Migration (shared tenancy only) — apply DDL so the server is
 *      schema-current without a separate CLI step. This is a TRANSIENT-fault
 *      surface (a cold-start network blip), so unlike (1) it must NEVER throw:
 *      retry once, then log and keep serving (schema is applied out-of-band at
 *      deploy time anyway). See the cold-start incident note below.
 *
 * The two are deliberately different: missing env is deterministic → fail;
 * a flaky migration is transient → never poison the instance.
 *
 * ALL Node-only work lives inside the `process.env.NEXT_RUNTIME === "nodejs"`
 * block. Next.js compiles instrumentation.ts for the edge runtime too and
 * inlines NEXT_RUNTIME per bundle, so that positive guard is dead-code
 * eliminated from the edge build — which is why the node:fs / ./lib/migrate
 * dynamic imports inside it never reach (and never break) the edge bundle.
 */

// Sources whose value the DEPLOY is responsible for injecting — mirror of
// agents/build/env_contract.py DEPLOY_INJECTED_SOURCES. A var declared with
// one of these is required in the running environment at boot.
const DEPLOY_INJECTED_SOURCES = new Set(["secret", "generated", "fixed"]);

// A remote libSQL/Turso database requires an auth token; a local file: or
// :memory: database does not. So DATABASE_AUTH_TOKEN is only *required* when
// DATABASE_URL points at a remote scheme — this keeps dev and CI (file: URLs)
// runnable without a token while still catching a missing token in prod.
const REMOTE_DB_SCHEME = /^(libsql|https?|wss?):/i;

/**
 * Parse `.env.contract` text into the list of names the deploy must inject
 * (source secret/generated/fixed). Blanks, comments, and infra/app-source
 * lines are ignored. Pure — no I/O, exported for unit testing.
 */
export function requiredBootEnv(contractText: string): string[] {
  const required: string[] = [];
  for (const rawLine of contractText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const name = line.slice(0, eq).trim();
    const source = line.slice(eq + 1).trim().split(/\s+/)[0].toLowerCase();
    if (name && DEPLOY_INJECTED_SOURCES.has(source)) required.push(name);
  }
  return required;
}

/**
 * Assert the running environment satisfies a parsed contract. Throws — loudly,
 * naming every missing variable — when a deploy-injected var is absent. Pure
 * (no I/O): exported so the presence logic is unit-tested without touching the
 * filesystem, and so it carries no edge-unsafe imports.
 */
export function assertBootEnv(contractText: string): void {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const missing = requiredBootEnv(contractText).filter((name) => {
    // DATABASE_AUTH_TOKEN is required only for a remote database URL.
    if (name === "DATABASE_AUTH_TOKEN" && !REMOTE_DB_SCHEME.test(dbUrl)) {
      return false;
    }
    const value = process.env[name];
    return value === undefined || value === "";
  });

  if (missing.length > 0) {
    throw new Error(
      "instrumentation: required environment variable(s) missing at boot: " +
        `${missing.join(", ")}. These are declared deploy-injected in ` +
        ".env.contract but are absent from the running environment. A " +
        "production deploy that skips safe-env-deploy's contract check must " +
        "still provide every contract var — refusing to start with a partial " +
        "environment rather than returning 500 per request. Set the named " +
        "variable(s) and redeploy.",
    );
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // (1) Deterministic misconfiguration — fail loudly at boot.
    //
    // Read the repo-root .env.contract and assert the environment against it.
    // If the contract file itself cannot be read (e.g. not bundled into a
    // given serverless output) validation is SKIPPED with a warning rather
    // than crashing: a missing contract file is a bundling quirk, not the
    // deterministic env misconfiguration this guard exists to catch. The
    // assert, however, runs OUTSIDE the read try/catch so its intended throw
    // is never swallowed.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const contractPath = join(process.cwd(), ".env.contract");
    let contractText: string | null = null;
    try {
      contractText = readFileSync(contractPath, "utf8");
    } catch {
      console.warn(
        `instrumentation: .env.contract not readable at ${contractPath} — ` +
          "skipping boot env validation (the file is version-controlled at " +
          "the repo root; this only happens if it was not bundled into the " +
          "runtime).",
      );
    }
    if (contractText !== null) assertBootEnv(contractText);

    // (2) Boot migration — shared tenancy only (per-tenant needs per-tenant
    // orchestration via scripts/migrate-all-tenants.ts). Safe to call
    // repeatedly: all DDL in MIGRATION_SQL uses IF NOT EXISTS.
    const mode = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase();
    if (mode === "shared") {
      const url = process.env.DATABASE_URL;
      if (url) {
        const { migrate } = await import("./lib/migrate");
        // A cold-start migration failure must NEVER poison the instance:
        // Next.js treats a throw from register() as a failed instrumentation
        // hook and the instance then 500s EVERY request it serves. Observed
        // live on the k9coach preview 2026-07-16 — a transient
        // `connect ETIMEDOUT <turso-host>:443` at cold start turned into
        // "500 on every authenticated page" for users pinned to that instance.
        // The schema is already applied out-of-band at deploy time
        // (safe-env-deploy runs scripts/migrate.ts); this boot migration is
        // belt-and-braces, so: retry once for transient network faults, then
        // log loudly and keep serving.
        try {
          await migrate(url, process.env.DATABASE_AUTH_TOKEN);
        } catch (firstError) {
          console.error(
            "instrumentation: migration attempt 1 failed, retrying once",
            firstError,
          );
          try {
            await migrate(url, process.env.DATABASE_AUTH_TOKEN);
          } catch (secondError) {
            console.error(
              "instrumentation: migration failed at cold start — continuing " +
                "to serve (schema is applied at deploy time)",
              secondError,
            );
          }
        }
      }
    }
  }
}
