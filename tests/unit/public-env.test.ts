// @vitest-environment node
//
// Which environment values reach the browser (app-business-core issues 797 and
// 353 leg c; Matt Murphy #242: "environment variables prefixed with NEXT_PUBLIC
// or VITE shipped to the browser — know which ones"; #293: "every secret should
// be in server-side env vars only — not in code, not in git, not in the
// browser").
//
//   * every NEXT_PUBLIC_ (and VITE_) name the source or the environment
//     contract mentions is on the allow-list in config/public-env.ts, with a
//     reason;
//   * no listed name looks like a secret;
//   * the source holds no key-shaped value (a Stripe, Resend, AWS, GitHub or
//     Anthropic key, a private-key block, a database connection string with a
//     password in it) — the template's own secret scan, next to gitleaks.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ENV, SECRET_NAME_PARTS } from "@/config/public-env";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (!dir && !["app", "components", "lib", "config", "scripts", "content", "types"].includes(name)) continue;
      out.push(...walk(rel));
    } else if (/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(name)) out.push(rel);
  }
  return out;
}

const ROOT_FILES = readdirSync(ROOT).filter((n) => /\.(ts|mjs|js|json)$/.test(n) || n.startsWith(".env."));
const FILES = [...walk(""), ...ROOT_FILES.filter((n) => !n.includes("lock"))];
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("public environment variables (#797, #353)", () => {
  it("are all on the allow-list", () => {
    const named = new Map<string, string>();
    for (const f of FILES) {
      if (f === "config/public-env.ts") continue;
      for (const m of read(f).matchAll(/\b((?:NEXT_PUBLIC|VITE)_[A-Z0-9_]+)/g)) named.set(m[1], f);
    }
    expect(named.size).toBeGreaterThan(0);
    const unlisted = [...named].filter(([n]) => !(n in PUBLIC_ENV)).map(([n, f]) => `${n} (${f})`);
    expect(unlisted).toEqual([]);
  });

  it("never names a secret", () => {
    for (const [name, why] of Object.entries(PUBLIC_ENV)) {
      expect(name.replace(/^NEXT_PUBLIC_/, ""), name).not.toMatch(SECRET_NAME_PARTS);
      expect(why.length, name).toBeGreaterThan(10);
    }
  });

  it("the secret-name check catches the usual mistakes", () => {
    for (const bad of ["STRIPE_SECRET_KEY", "API_KEY", "DATABASE_URL", "AUTH_TOKEN", "RESEND_API_KEY", "SUPABASE_SERVICE_KEY"]) {
      expect(bad, bad).toMatch(SECRET_NAME_PARTS);
    }
  });
});

// Key-shaped values. Placeholders the template documents (sk_test_..., re_...)
// are short or contain dots and do not match.
const KEY_SHAPES: [string, RegExp][] = [
  ["Stripe secret or restricted key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{20,}/],
  ["Resend key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["connection string with a password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|libsql|redis):\/\/[^\s:@/'"]+:[^\s@/'"]{6,}@/],
];

describe("no hard-coded key in the source (#353 leg c)", () => {
  it("finds none", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      if (f.startsWith(".env.")) continue;
      const text = read(f);
      for (const [what, re] of KEY_SHAPES) if (re.test(text)) hits.push(`${f}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it("each shape catches its seeded example", () => {
    const seeded = [
      "sk_live_" + "a1B2c3D4e5F6g7H8i9J0k1L2",
      "whsec_" + "a1B2c3D4e5F6g7H8i9J0k1L2",
      "re_" + "a1B2c3D4_" + "e5F6g7H8i9J0k1L2m3",
      "AKIA" + "ABCDEFGHIJ012345",
      "ghp_" + "a".repeat(36),
      "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0",
      "-----BEGIN RSA " + "PRIVATE KEY-----",
      "postgres://app:" + "hunter22secret@db.example.com/app",
    ];
    KEY_SHAPES.forEach(([what, re], i) => expect(seeded[i], what).toMatch(re));
  });
});
