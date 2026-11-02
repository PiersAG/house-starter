// @vitest-environment node
//
// Server code and secrets stay out of the browser bundle (app-business-core
// issue 797; Matt Murphy #54: "install the server only package and mark every
// sensitive file"; "add the server only import to every file that touches your
// database, your API keys, or any of your credentials"; "separate server logic
// and client components into different files"; "move every server function
// into dedicated files so that they share no exports with anything that
// renders in the browser and verify no server import chain reaches a client
// entry point").
//
//   1. THE MARKER — every module under lib/, config/ and components/ that
//      imports a database, key or credential module, or reads a server
//      environment variable, starts with `import "server-only"`. Next.js then
//      fails the build if a client component reaches it.
//   2. THE CHAINS — from every "use client" file, the value imports are walked
//      (type-only imports are erased and do not count; a "use server" file is a
//      server reference and is not followed). No chain may reach a marked file
//      or a file the rule says should be marked.
//   3. A "use client" file reads no server environment variable and is never
//      itself marked; a "use server" file exports only async functions (the
//      server actions), so it shares nothing else with the browser.
//   4. The Node shim that lets tooling load marked files
//      (scripts/server-only-node.cjs) is never imported by the app itself.
// The built-output scan that proves no secret reached the browser files is the
// factory's planted gate (dast job, "Scan the built browser output").

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { clientReach } from "./data-boundary-audit";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCE = ["app", "components", "lib", "config"].flatMap(walk);
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** Imports that touch a database, a key or a credential. */
const SENSITIVE_IMPORT =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["'](@libsql\/client|drizzle-orm(?!\/sqlite-core)[^"']*|stripe|resend|bcryptjs|otplib|node:crypto|crypto|next-auth[^"']*|@\/lib\/(db|catalog|tenant-context|secrets|vault|crypto\/[^"']*)|\.\.?\/(db|catalog|tenant-context|secrets|vault|crypto\/[^"']*))["']/m;
/** A server environment variable (anything but NEXT_PUBLIC_* and NODE_ENV). */
const SERVER_ENV = /process\.env(\.(?!NEXT_PUBLIC_|NODE_ENV\b)[A-Z_]+|\[|\b(?!\.))/;
const MARKER = /^import\s+["']server-only["'];?\s*$/m;
const CLIENT = /^\s*["']use client["']/;
const SERVER_ACTIONS = /^\s*["']use server["']/;

/**
 * Not yet marked, with the reason. Each line is removed by the change that
 * marks it; the test fails if a listed file is already marked or no longer
 * needs to be, so the list cannot go stale.
 */
const PENDING: Record<string, string> = {
  // Money path: frozen for Dispatch AB while Dispatch AA's payments change
  // lands. The next payments dispatch adds the marker to these four files.
  "lib/billing/grants.ts": "payments dispatch",
  "lib/billing/stripe.ts": "payments dispatch",
  "lib/billing/subscriptions.ts": "payments dispatch",
  "lib/billing/webhook.ts": "payments dispatch",
  // A payments component (bundle S13): a server component that reads the
  // subscription; the payments dispatch adds the marker.
  "components/billing/PlanCard.tsx": "payments dispatch",
  "lib/billing/ledger.ts": "payments dispatch",
  // Sign-in kernel files the safety gate keeps from Claude Code: the CEO script
  // of Dispatch AB applies the marker (and removes these two lines).
  "lib/auth.ts": "kernel edit in the CEO script",
  "lib/auth-rate-limit.ts": "kernel edit in the CEO script",
};

const needsMarker = (f: string) =>
  /^(lib|config|components)\//.test(f) && !CLIENT.test(read(f)) && (SENSITIVE_IMPORT.test(read(f)) || SERVER_ENV.test(read(f)));

describe("server-only marker (#797)", () => {
  it("is installed as a dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["server-only"]).toBe("0.0.1");
  });

  it("is the first import of every module that touches the database, a key or a credential", () => {
    const missing = SOURCE.filter((f) => needsMarker(f) && !MARKER.test(read(f)) && !PENDING[f]);
    expect(missing).toEqual([]);
  });

  it("marks enough files to mean something", () => {
    const marked = SOURCE.filter((f) => MARKER.test(read(f)));
    for (const f of ["lib/db.ts", "lib/catalog.ts", "lib/secrets.ts", "lib/vault.ts", "lib/crypto/secret-box.ts", "lib/csrf.ts", "lib/dto.ts"]) {
      expect(marked, f).toContain(f);
    }
  });

  it("keeps its pending list true", () => {
    for (const f of Object.keys(PENDING)) {
      expect(needsMarker(f), `${f} no longer needs the marker — drop it from PENDING`).toBe(true);
      expect(MARKER.test(read(f)), `${f} is marked — drop it from PENDING`).toBe(false);
    }
  });
});

describe("no server import chain reaches the browser (#797)", () => {
  const clients = SOURCE.filter((f) => CLIENT.test(read(f)));
  const reach = clientReach(ROOT, clients);

  it("finds the client entry points", () => {
    expect(clients).toEqual(expect.arrayContaining(["app/dashboard/settings/SettingControl.tsx", "components/AppNav.tsx"]));
  });

  it("reaches no marked file and no file that touches server data", () => {
    const bad = [...reach.entries()]
      .filter(([f]) => !SERVER_ACTIONS.test(read(f)) && (MARKER.test(read(f)) || needsMarker(f)))
      .map(([f, chain]) => `${f}: ${chain.join(" → ")}`);
    expect(bad).toEqual([]);
  });

  it("reads no server environment variable in a client file, and marks no client file", () => {
    const bad = clients.filter((f) => SERVER_ENV.test(read(f)) || MARKER.test(read(f)));
    expect(bad).toEqual([]);
  });

  it("puts server actions in their own files, exporting only async functions", () => {
    const actions = SOURCE.filter((f) => SERVER_ACTIONS.test(read(f)));
    expect(actions.length).toBeGreaterThan(0);
    for (const f of actions) {
      const exports = read(f).match(/^export\s+(?!type\b|interface\b)[^\n]*/gm) ?? [];
      for (const e of exports) expect(e, `${f}: ${e}`).toMatch(/^export\s+async\s+function\b/);
    }
  });

  it("the seeded case: a client file importing the database is caught", () => {
    // The walk itself, on the template's real files: an entry point that
    // imports lib/catalog reaches lib/secrets through it, and both are marked.
    const chain = clientReach(ROOT, ["lib/catalog.ts"]).get("lib/secrets.ts");
    expect(chain).toEqual(["lib/catalog.ts", "lib/secrets.ts"]);
    expect(MARKER.test(read("lib/secrets.ts"))).toBe(true);
  });
});

describe("the Node shim stays with the tooling", () => {
  it("is never imported by app, component, library or config code", () => {
    const users = [...SOURCE, "middleware.ts", "instrumentation.ts", "auth.config.ts"].filter((f) =>
      /server-only-node/.test(read(f)),
    );
    expect(users).toEqual([]);
  });

  it("is replaced by its empty half in every vitest config", () => {
    const configs = readdirSync(ROOT).filter((n) => /^vitest(\..+)?\.config\.(ts|mts|mjs|js)$/.test(n));
    expect(configs.length).toBeGreaterThan(1);
    for (const c of configs) expect(read(c), c).toMatch(/"server-only":\s*path\.resolve\(__dirname, "node_modules\/server-only\/empty\.js"\)/);
  });

  it("is loaded first by every script that imports lib/, and by the Playwright config", () => {
    const scripts = readdirSync(join(ROOT, "scripts"))
      .filter((n) => n.endsWith(".ts"))
      .map((n) => `scripts/${n}`)
      .filter((f) => /from\s+["']\.\.\/lib\//.test(read(f)));
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of [...scripts, "playwright.config.ts"]) {
      const firstImport = read(f).split("\n").find((l) => /^import\s/.test(l));
      expect(firstImport, f).toMatch(/server-only-node\.cjs/);
    }
  });
});

void relative;
