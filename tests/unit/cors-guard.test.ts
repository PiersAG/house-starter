// CORS guard (PiersAG/app-business-core#742; Matt Murphy #14, #68, #220):
// "when you set CORS to allow everything you told the browser you trust
// everyone". The policy lives in lib/cors.ts and config/cors.ts only, so a
// future change cannot open it quietly:
//
//   * no other source file, config file or vercel.json sets a CORS header;
//   * lib/cors.ts has no wildcard value;
//   * every config/cors.ts entry is one exact origin — https, or http only for
//     localhost — with no path and no wildcard.
//
// The guard reads the source tree only, so it runs on the template and on
// every app built from it, and its own checks are tested against planted
// examples below.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CORS_ALLOWED_ORIGINS } from "@/config/cors";

const ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "lib", "components", "config"];
const SCANNED_FILES = ["middleware.ts", "next.config.ts", "vercel.json", "instrumentation.ts", "auth.config.ts"];
const OWNER = "lib/cors.ts";
const CORS_HEADER = /access-control-allow-(origin|credentials|methods|headers)/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|mjs|json)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(path);
  }
  return out;
}

function scannedFiles(): string[] {
  const files = SCANNED_DIRS.flatMap((d) => walk(join(ROOT, d)));
  for (const f of SCANNED_FILES) {
    try {
      statSync(join(ROOT, f));
      files.push(join(ROOT, f));
    } catch {
      // not every app has every root file
    }
  }
  return files;
}

/** Files other than lib/cors.ts that name a CORS response header. */
export function corsHeaderWriters(files: { path: string; text: string }[]): string[] {
  return files.filter((f) => f.path !== OWNER && CORS_HEADER.test(f.text)).map((f) => f.path);
}

/** A wildcard value anywhere in the CORS owner. */
export function hasWildcard(text: string): boolean {
  return /["'`]\*["'`]/.test(text) || /allow-origin["']?\s*[:,]\s*["'`]\*/i.test(text);
}

/** Problems with a hard-coded allowlist entry. */
export function originEntryProblem(entry: string): string | null {
  if (entry.includes("*")) return `${entry}: wildcard`;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return `${entry}: not a URL`;
  }
  if (url.origin !== entry) return `${entry}: not one exact origin (no path, no trailing slash)`;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return `${entry}: not https`;
  return null;
}

const files = scannedFiles().map((path) => ({
  path: relative(ROOT, path).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));

describe("this app's CORS policy has one owner and no wildcard", () => {
  it("scans the source tree, including the owner", () => {
    expect(files.some((f) => f.path === OWNER)).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it("no file but lib/cors.ts sets a CORS header", () => {
    expect(corsHeaderWriters(files)).toEqual([]);
  });

  it("lib/cors.ts has no wildcard value", () => {
    expect(hasWildcard(files.find((f) => f.path === OWNER)!.text)).toBe(false);
  });

  it("every hard-coded allowlist entry is one exact https origin", () => {
    expect(CORS_ALLOWED_ORIGINS.map(originEntryProblem).filter(Boolean)).toEqual([]);
  });
});

describe("the guard catches what it is for (planted examples)", () => {
  it("a route that sets Access-Control-Allow-Origin itself", () => {
    expect(
      corsHeaderWriters([
        { path: "app/api/data/route.ts", text: 'headers: { "Access-Control-Allow-Origin": origin }' },
        { path: "next.config.ts", text: '{ key: "access-control-allow-credentials", value: "true" }' },
        { path: OWNER, text: '"Access-Control-Allow-Origin": match' },
        { path: "lib/other.ts", text: "nothing to see" },
      ]),
    ).toEqual(["app/api/data/route.ts", "next.config.ts"]);
  });

  it("a wildcard in the owner", () => {
    expect(hasWildcard('"Access-Control-Allow-Origin": "*"')).toBe(true);
    expect(hasWildcard("return '*';")).toBe(true);
    expect(hasWildcard('"Access-Control-Allow-Origin": match')).toBe(false);
  });

  it("bad allowlist entries", () => {
    expect(originEntryProblem("*")).toMatch(/wildcard/);
    expect(originEntryProblem("https://*.example.com")).toMatch(/wildcard/);
    expect(originEntryProblem("example.com")).toMatch(/not a URL/);
    expect(originEntryProblem("https://www.example.com/")).toMatch(/exact origin/);
    expect(originEntryProblem("http://www.example.com")).toMatch(/not https/);
    expect(originEntryProblem("https://www.example.com")).toBeNull();
    expect(originEntryProblem("http://localhost:3000")).toBeNull();
  });
});
