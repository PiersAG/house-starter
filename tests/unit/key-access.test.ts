// Each module receives only the keys it needs (PiersAG/app-business-core#760).
//
// Two halves:
//   1. STATIC — every place the source reads a key the manifest
//      (lib/key-access.json) lists is in a file the manifest names as a reader
//      of that key; a scrubbed key is never read straight from process.env by
//      server code; every `secret` line in .env.contract has a manifest entry.
//   2. RUNTIME — scrubSecretsFromEnv takes every scrubbed key out of
//      process.env, so a package reading process.env sees none of them, while
//      readSecret still hands each key to its listed reader.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "@/lib/key-access.json";
import {
  SCRUBBED_KEYS,
  SecretAccessError,
  __resetSecretsForTests,
  readSecret,
  scrubSecretsFromEnv,
  secretsScrubbed,
} from "@/lib/secrets";

const ROOT = join(__dirname, "..", "..");
const KEYS = manifest.keys as Record<string, { readers: string[]; scrub: boolean }>;
const NAMES = Object.keys(KEYS);

// Server code, plus the command-line scripts (which run outside the server and
// may read process.env directly). Tests are excluded: they set keys up.
const SOURCE_DIRS = ["app", "lib", "components", "scripts"];
const ROOT_FILES = ["auth.config.ts", "middleware.ts", "instrumentation.ts", "next.config.ts"];
const CLI_PREFIXES = ["scripts/"];
const CONFIG_FILES = ["drizzle.config.ts", "playwright.config.ts"];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(relative(ROOT, p).split("\\").join("/"));
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const d of SOURCE_DIRS) walk(join(ROOT, d), out);
  for (const f of ROOT_FILES) {
    try {
      statSync(join(ROOT, f));
      out.push(f);
    } catch {
      /* not every app has every root file */
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ways a file can read key `name`. */
function readPatterns(name: string): { direct: RegExp; any: RegExp } {
  const n = esc(name);
  const direct = new RegExp(`process\\.env(?:\\.${n}\\b|\\[\\s*["'\`]${n}["'\`]\\s*\\])`);
  const any = new RegExp(
    `(?:\\benv(?:\\.${n}\\b|\\[\\s*["'\`]${n}["'\`]\\s*\\]))|` +
      `(?:\\b(?:readSecret|getKey)\\(\\s*["'\`]${n}["'\`])`,
  );
  return { direct, any };
}

describe("key access — static", () => {
  const files = sourceFiles().map((f) => ({ f, text: readFileSync(join(ROOT, f), "utf8") }));

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const name of NAMES) {
    const { direct, any } = readPatterns(name);
    const readers = new Set(KEYS[name].readers);

    it(`${name} is read only by its listed readers`, () => {
      const offenders = files
        // lib/secrets.ts is the store itself; its comments name keys.
        .filter(({ f, text }) => f !== "lib/secrets.ts" && any.test(text) && !readers.has(f))
        .map(({ f }) => f);
      expect(offenders, `files reading ${name} that key-access.json does not list`).toEqual([]);
    });

    it(`${name}: every listed reader exists and reads it`, () => {
      for (const r of readers) {
        const text = readFileSync(join(ROOT, r), "utf8");
        expect(any.test(text), `${r} is listed as reading ${name} but does not`).toBe(true);
      }
    });

    if (KEYS[name].scrub) {
      it(`${name} is never read straight from process.env by server code`, () => {
        const offenders = files
          .filter(
            ({ f, text }) =>
              direct.test(text) &&
              !CLI_PREFIXES.some((p) => f.startsWith(p)) &&
              f !== "lib/secrets.ts",
          )
          .map(({ f }) => f);
        expect(offenders, `read ${name} through readSecret() instead`).toEqual([]);
      });
    }
  }

  it("no server code reads a key through a name it computes (readSecret's first argument is a literal)", () => {
    const offenders = files
      .filter(({ f }) => f !== "lib/secrets.ts" && f !== "lib/vault.ts")
      .filter(({ text }) => /\breadSecret\(\s*[^"'`\s)]/.test(text))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it("every secret in .env.contract has an entry, with its readers", () => {
    const contract = readFileSync(join(ROOT, ".env.contract"), "utf8");
    const secrets = contract
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().split(/\s+/)[0]])
      .filter(([, source]) => source === "secret")
      .map(([n]) => n);
    expect(secrets.length).toBeGreaterThan(0);
    const missing = secrets.filter((n) => !NAMES.includes(n));
    expect(missing, "add these to lib/key-access.json").toEqual([]);
  });

  it("every key that stays in the environment says why", () => {
    for (const [name, entry] of Object.entries(manifest.keys)) {
      if (!(entry as { scrub: boolean }).scrub) {
        expect(
          (entry as { why_not_scrubbed?: string }).why_not_scrubbed,
          `${name} is not scrubbed and gives no reason`,
        ).toBeTruthy();
      }
    }
  });

  it("config files that are not part of the server are the only other readers", () => {
    // drizzle.config.ts and playwright.config.ts run on a developer machine or
    // in CI, never in the deployed app; recorded here so the list is deliberate.
    for (const f of CONFIG_FILES) expect(SOURCE_DIRS.some((d) => f.startsWith(`${d}/`))).toBe(false);
  });
});

describe("key access — runtime", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetSecretsForTests();
  });

  function set(name: string, value: string) {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  }

  it("takes every scrubbed key out of process.env and still hands it to readSecret", () => {
    set("EMAIL_PROVIDER_API_KEY", "re_not_real_1");
    set("DATABASE_AUTH_TOKEN", "db-token-not-real");
    const moved = scrubSecretsFromEnv();
    expect(moved).toEqual(expect.arrayContaining(["EMAIL_PROVIDER_API_KEY", "DATABASE_AUTH_TOKEN"]));
    expect(secretsScrubbed()).toBe(true);
    // what a package in the dependency tree would see
    expect(process.env.EMAIL_PROVIDER_API_KEY).toBeUndefined();
    expect(process.env.DATABASE_AUTH_TOKEN).toBeUndefined();
    expect(Object.keys(process.env)).not.toContain("EMAIL_PROVIDER_API_KEY");
    expect(JSON.stringify(process.env)).not.toContain("re_not_real_1");
    // what the listed reader sees
    expect(readSecret("EMAIL_PROVIDER_API_KEY")).toBe("re_not_real_1");
    expect(readSecret("DATABASE_AUTH_TOKEN")).toBe("db-token-not-real");
  });

  it("leaves the keys that are not scrubbed (the sign-in secret) in place", () => {
    set("AUTH_SECRET", "auth-secret-not-real");
    scrubSecretsFromEnv();
    expect(process.env.AUTH_SECRET).toBe("auth-secret-not-real");
    expect(SCRUBBED_KEYS).not.toContain("AUTH_SECRET");
  });

  it("refuses a key the manifest does not list, naming it and no value", () => {
    expect(() => readSecret("SOME_UNLISTED_KEY")).toThrow(SecretAccessError);
    expect(() => readSecret("SOME_UNLISTED_KEY")).toThrow(/SOME_UNLISTED_KEY.*key-access\.json/);
  });

  it("reads a caller's own environment object without touching the store", () => {
    expect(readSecret("TURSO_API_TOKEN", { TURSO_API_TOKEN: "t-not-real" })).toBe("t-not-real");
    expect(readSecret("TURSO_API_TOKEN", {})).toBeUndefined();
  });

  it("before the scrub (scripts, tests) reads process.env as before", () => {
    set("TURSO_API_TOKEN", "t2-not-real");
    expect(readSecret("TURSO_API_TOKEN")).toBe("t2-not-real");
  });
});

describe("key access — runtime edges", () => {
  afterEach(() => __resetSecretsForTests());

  it("removes an empty key without storing it, and leaves the process flag alone for a caller's own env", () => {
    const own: Record<string, string | undefined> = { EMAIL_PROVIDER_API_KEY: "", TURSO_API_TOKEN: "t-not-real" };
    const moved = scrubSecretsFromEnv(own as NodeJS.ProcessEnv);
    expect(moved.sort()).toEqual(["EMAIL_PROVIDER_API_KEY", "TURSO_API_TOKEN"]);
    expect(own).toEqual({});
    expect(secretsScrubbed()).toBe(false);
    expect(readSecret("EMAIL_PROVIDER_API_KEY")).toBeUndefined();
  });
});
