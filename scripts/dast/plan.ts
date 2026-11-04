// The active scan's plan (app-business-core issue 533; Matt Murphy #223: "ZAP
// should crawl every page, test every form and probe every API endpoint for
// injection before the first user").
//
//   npx tsx scripts/dast/plan.ts --base http://127.0.0.1:3000 --session dast-results/session.json --dir dast-results
//
// Writes two files into --dir for OWASP ZAP's Automation Framework:
//
//   openapi.json  every API route under app/api, DISCOVERED from the source (a
//                 route the builder adds is in the next scan), with each verb it
//                 exports and an example body built from the field names its
//                 source validates — so the active scanner has a request to
//                 attack for every endpoint, not only the pages its spider finds.
//   plan.yaml     the run: sign-in headers on every request (the session cookie
//                 and the request token from scripts/dast/session.ts), the API
//                 import, the spider over every page, the passive rules, the
//                 ACTIVE scan (attack payloads) with a time limit, and the
//                 report. JSON is valid YAML, so the plan is written as JSON.
//
// SCAN_EXCLUSIONS are the requests the scan must not send because they end its
// own session or remove its account; each carries its reason, and the gate
// (scripts/dast/gate.ts) re-checks the session after the scan, so a session
// lost some other way fails the run instead of passing it signed out.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAllRoutes, type DiscoveredRoute } from "../../tests/isolation/route-map";
import { assertLocalTarget, SCAN_ADDRESS, SESSION_COOKIE, type ScanSession } from "./session";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";

/** Requests the scan never sends, as path regexes relative to the base. */
export const SCAN_EXCLUSIONS: { pattern: string; reason: string }[] = [
  { pattern: "/api/auth/signout.*", reason: "signs the scan's own session out" },
  { pattern: "/api/auth/callback/.*", reason: "sign-in attempts: the sign-in limits would ban the scan's address" },
  { pattern: "/api/auth/signin.*", reason: "sign-in pages for other providers; the credentials form is scanned at /login" },
  { pattern: "/sessions/revoke.*", reason: "revokes sessions, the scan's own included" },
  { pattern: "/account-closed.*", reason: "the page after closing the account" },
];

/** Minutes the active scan may run; the job's own timeout sits above it. */
export const ACTIVE_SCAN_MINUTES = 20;
export const SPIDER_MINUTES = 3;

const SAMPLE = "zap";

/**
 * Route-parameter values that reach the handler. An unknown setting key is
 * refused before the body is read (measured: 1,955 of the first CI scan's
 * settings requests answered 404), so the settings route gets a real setting an
 * owner may write, and the payloads reach its value handling. Every other
 * parameter gets the sample.
 */
export function ownerSettingKey(): string {
  const writable = ALL_DEFINITIONS.filter((d) => d.ownerEditable !== false && !d.operatorOnly);
  return (writable.find((d) => d.valueType === "text") ?? writable[0])?.key ?? SAMPLE;
}

export const PARAM_EXAMPLES: Record<string, Record<string, () => string>> = {
  "/api/settings/[key]": { key: ownerSettingKey },
};

function paramExample(route: string, name: string): string {
  return PARAM_EXAMPLES[route]?.[name]?.() ?? SAMPLE;
}

/** Field names a route's source validates, from `name: z.…` and `name: …Field` entries. */
export function bodyFields(source: string): string[] {
  const fields = new Set<string>();
  for (const m of source.matchAll(/["']?([A-Za-z_][\w-]*)["']?\s*:\s*(?:z\.|\w+Field\b|\w+Schema\b)/g)) fields.add(m[1]);
  return [...fields].sort();
}

type Operation = { operationId: string; parameters?: unknown[]; requestBody?: unknown; responses: unknown };

export function openApiFor(routes: DiscoveredRoute[], base: string, read = (f: string) => readFileSync(f, "utf8")) {
  const paths: Record<string, Record<string, Operation>> = {};
  for (const route of routes.filter((r) => r.kind === "api" && r.file)) {
    if (route.path.startsWith("/api/auth/[")) continue; // Auth.js's own endpoints: the session's provider, see SCAN_EXCLUSIONS
    const path = route.path.replace(/\[\[?(?:\.\.\.)?(\w+)\]?\]/g, "{$1}");
    const source = read(route.file as string);
    const fields = bodyFields(source);
    const example = Object.fromEntries((fields.length ? fields : ["value"]).map((f) => [f, SAMPLE]));
    const parameters = route.params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string", example: paramExample(route.path, name) },
    }));
    for (const method of route.methods.filter((m) => m !== "OPTIONS" && m !== "HEAD")) {
      const op: Operation = {
        operationId: `${method.toLowerCase()} ${route.path}`,
        responses: { default: { description: "any" } },
      };
      if (parameters.length) op.parameters = parameters;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        op.requestBody = {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: Object.fromEntries(Object.keys(example).map((f) => [f, { type: "string", example: SAMPLE }])),
              },
            },
          },
        };
      }
      (paths[path] ??= {})[method.toLowerCase()] = op;
    }
  }
  return {
    openapi: "3.0.3",
    info: { title: "API routes discovered under app/api (active scan)", version: "1" },
    servers: [{ url: new URL(base).origin }],
    paths,
  };
}

/** Escape a literal for a Java regex (ZAP's include/exclude patterns). */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extra pages the spider starts from, from SCAN_EXTRA_START (comma-separated
 * paths). Only the self-test sets it, to reach its seeded page.
 */
export function extraStarts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.SCAN_EXTRA_START ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("/") && !p.startsWith("//"));
}

export function automationPlan(base: string, session: ScanSession, dir: string, starts: string[] = []) {
  const origin = new URL(base).origin;
  const header = (description: string, name: string, value: string) => ({
    description,
    url: `${literal(origin)}.*`,
    matchType: "req_header",
    matchString: name,
    matchRegex: false,
    replacementString: value,
    tokenProcessing: false,
  });
  return {
    env: {
      contexts: [
        {
          name: "app",
          urls: [origin],
          includePaths: [`${literal(origin)}.*`],
          excludePaths: SCAN_EXCLUSIONS.map((e) => `${literal(origin)}${e.pattern}`),
        },
      ],
      parameters: { failOnError: true, failOnWarning: false, progressToStdout: true },
    },
    jobs: [
      {
        type: "replacer",
        parameters: { deleteAllRules: true },
        rules: [
          header("signed in: the scan account's session", "Cookie", `${SESSION_COOKIE}=${session.cookie}`),
          header("signed in: the request token every write needs", session.csrfHeader, session.csrfToken),
          header("the scan's own client address", "x-forwarded-for", SCAN_ADDRESS),
        ],
      },
      { type: "openapi", parameters: { apiFile: join(dir, "openapi.json"), targetUrl: origin, context: "app" } },
      { type: "spider", parameters: { context: "app", url: `${origin}/dashboard`, maxDuration: SPIDER_MINUTES } },
      { type: "spider", parameters: { context: "app", url: origin, maxDuration: SPIDER_MINUTES } },
      ...starts.map((path) => ({ type: "spider", parameters: { context: "app", url: `${origin}${path}`, maxDuration: 1 } })),
      { type: "passiveScan-wait", parameters: { maxDuration: 5 } },
      {
        type: "activeScan",
        parameters: { context: "app", maxScanDurationInMins: ACTIVE_SCAN_MINUTES, maxRuleDurationInMins: 4 },
        policyDefinition: { defaultStrength: "medium", defaultThreshold: "medium" },
      },
      { type: "passiveScan-wait", parameters: { maxDuration: 5 } },
      {
        type: "report",
        parameters: { template: "traditional-json", reportDir: dir, reportFile: "report.json" },
      },
      {
        type: "report",
        parameters: { template: "traditional-md", reportDir: dir, reportFile: "report.md" },
      },
    ],
  };
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function main(): void {
  const base = arg("--base", "http://127.0.0.1:3000");
  assertLocalTarget(base);
  // Where ZAP reaches the same app: the base itself on a CI runner (host
  // network); `http://host.docker.internal:3000` under Docker Desktop.
  const zapBase = arg("--zap-base", base);
  assertLocalTarget(zapBase, { dockerHost: true });
  const dir = resolve(arg("--dir", "dast-results"));
  // Paths ZAP sees: the results folder is mounted at /zap/wrk in its container.
  const zapDir = arg("--zap-dir", "/zap/wrk");
  const session = JSON.parse(readFileSync(arg("--session", join(dir, "session.json")), "utf8")) as ScanSession;
  mkdirSync(dir, { recursive: true });
  const api = openApiFor(discoverAllRoutes(resolve("app")), zapBase);
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(api, null, 2) + "\n");
  writeFileSync(join(dir, "plan.yaml"), JSON.stringify(automationPlan(zapBase, session, zapDir, extraStarts()), null, 2) + "\n", {
    mode: 0o600,
  });
  const operations = Object.values(api.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
  console.log(`Active scan plan written: ${operations} API operations, ${SCAN_EXCLUSIONS.length} exclusions.`);
}

if (process.argv[1]?.endsWith("plan.ts")) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`::error::Active scan plan: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
