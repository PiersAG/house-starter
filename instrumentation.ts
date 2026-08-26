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
 *   2. Migration — apply DDL so the server is schema-current without a
 *      separate CLI step. In shared mode that is the one database; in
 *      per_tenant it is the CATALOG (control plane), which holds identity and
 *      so must exist in every mode. This is a TRANSIENT-fault
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

// The shared rate-limit store is required on a DEPLOYED instance only. Same
// conditional shape as DATABASE_AUTH_TOKEN above, and for the same reason: a
// blanket requirement would stop `npm run dev`, CI and the isolation harness
// from booting, none of which have (or need) a Redis endpoint. VERCEL_ENV's
// PRESENCE is the signal — it is set on every deployed instance and nowhere
// else, and lib/tenant/provisioner.ts already treats it as THE test for
// "deployed". lib/rate-limit.ts refuses the in-memory stand-in under exactly the
// same condition; this makes the failure arrive at BOOT, naming the variable,
// rather than at the first login attempt.
const DEPLOY_ONLY_REQUIRED = new Set([
  "RATE_LIMIT_STORE_URL",
  "RATE_LIMIT_STORE_TOKEN",
]);

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
  const deployed = (process.env.VERCEL_ENV ?? "").trim().length > 0;
  const missing = requiredBootEnv(contractText).filter((name) => {
    // DATABASE_AUTH_TOKEN is required only for a remote database URL.
    if (name === "DATABASE_AUTH_TOKEN" && !REMOTE_DB_SCHEME.test(dbUrl)) {
      return false;
    }
    // The rate-limit store is required only on a deployed instance.
    if (DEPLOY_ONLY_REQUIRED.has(name) && !deployed) {
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

/**
 * Next.js error instrumentation (la-a-uptime-monitoring §b). Called by the
 * framework for every server-side error (route handlers, RSC, middleware).
 * Persists a structured record to the durable in-house sink so the exception
 * survives past Vercel's live-tail window — the class of failure that left the
 * checkout 500 undiagnosable after 16h.
 *
 * Node-only: the sink uses @libsql/client, which is not edge-safe, so the
 * import is dynamic and guarded by NEXT_RUNTIME — the edge build never pulls it
 * in. Never throws: an error while recording an error must not mask the
 * original.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recordError } = await import("./lib/observability/error-log");
    const err = error as { message?: string; stack?: string; digest?: string };
    await recordError({
      message: err?.message ? String(err.message) : String(error),
      stack: err?.stack ?? null,
      route: request?.path ?? context?.routePath ?? null,
      method: request?.method ?? null,
      digest: err?.digest ?? null,
      context: {
        routerKind: context?.routerKind,
        routePath: context?.routePath,
        renderSource: context?.renderSource,
      },
    });
  } catch (recordErr) {
    console.error(
      "instrumentation.onRequestError: failed to record error event",
      recordErr,
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

    // (2) Boot migration — apply the schema this instance needs without a
    // separate CLI step.
    //
    // WHICH DATABASE, BY MODE. This block used to run for `shared` ONLY, which
    // left a per_tenant app with NO catalog schema anywhere: nothing else in the
    // boot path creates it and CI runs no migration step, so the first sign-up
    // hit `SQLITE_ERROR: no such table: users` inside registerUser — and the
    // catch-all in app/signup/actions.ts turned that into a bland "Could not
    // create your account" (BLD.12). The catalog is the CONTROL PLANE: it holds
    // identity, so it has to exist in every tenancy mode and in every
    // environment the app boots in (CI, preview, production).
    //
    //   shared      — one database holds both planes: migrate it in full.
    //   per_tenant  — migrate the CATALOG ONLY. Tenant databases keep their
    //                 existing lifecycle: created and migrated per sign-up by
    //                 lib/tenant/provisioner.ts, and back-filled for existing
    //                 tenants by scripts/migrate-all-tenants.ts. Boot does not,
    //                 and must not, fan out over tenants.
    //
    // Safe to call repeatedly: every statement in the DDL uses IF NOT EXISTS.
    const mode = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase();

    // A cold-start migration failure must NEVER poison the instance: Next.js
    // treats a throw from register() as a failed instrumentation hook and the
    // instance then 500s EVERY request it serves. Observed live on the k9coach
    // preview 2026-07-16 — a transient `connect ETIMEDOUT <turso-host>:443` at
    // cold start turned into "500 on every authenticated page" for users pinned
    // to that instance. The schema is also applied out-of-band at deploy time,
    // so: retry once for transient network faults, then log loudly and keep
    // serving. Shared by both modes so neither can drift into throwing.
    const bootMigrate = async (
      what: string,
      apply: () => Promise<void>,
    ): Promise<void> => {
      try {
        await apply();
      } catch (firstError) {
        console.error(
          `instrumentation: ${what} migration attempt 1 failed, retrying once`,
          firstError,
        );
        try {
          await apply();
        } catch (secondError) {
          console.error(
            `instrumentation: ${what} migration failed at cold start — ` +
              "continuing to serve (schema is applied at deploy time)",
            secondError,
          );
        }
      }
    };

    if (mode === "shared") {
      const url = process.env.DATABASE_URL;
      if (url) {
        const { migrate } = await import("./lib/migrate");
        await bootMigrate("shared-database", () =>
          migrate(url, process.env.DATABASE_AUTH_TOKEN),
        );
      }
    } else {
      const { migrateCatalog } = await import("./lib/migrate");
      const { resolveCatalog } = await import("./lib/catalog");
      // resolveCatalog() prefers CATALOG_DATABASE_URL, falls back to
      // DATABASE_URL, and THROWS when neither is set. Resolving INSIDE the
      // guarded callback is deliberate: a misconfigured catalog is then
      // reported loudly at boot by the same handler, without turning every
      // subsequent request into a 500.
      await bootMigrate("catalog", async () => {
        const { url, authToken } = resolveCatalog();
        await migrateCatalog(url, authToken);
      });
    }
  }
}
