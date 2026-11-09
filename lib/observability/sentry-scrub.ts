// Stripping personal data and secrets from what goes to Sentry
// (PiersAG/app-business-core#761). The rules are listed in
// lib/observability/sentry.ts's header; tests/unit/sentry-scrub.test.ts holds
// each one. Pure: no server import, no I/O.

import { ENV_CONTRACT_NAMES } from "@/lib/observability/sentry-allow.generated";
import { SUBSCRIPTION_STATUSES } from "@/lib/observability/sentry-allow";

export interface SentryFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const MAX_MESSAGE = 1000;
const MAX_TAG = 200;
const MAX_FRAMES = 50;

// Quoted text: every quoted value goes (default-deny, Dispatch AT review 2 —
// the CEO's ruling of 2026-11-09). The one exception is a value that is,
// exactly and whole, one of the app's own fixed words: a setting name declared
// in .env.contract (sentry-allow.generated.ts) or a subscription status word.
// Nothing is kept for looking like code.
const KEEP_QUOTED: ReadonlySet<string> = new Set([...ENV_CONTRACT_NAMES, ...SUBSCRIPTION_STATUSES]);

const REDACTED = "[redacted]";
const SINGLE = new Set(["'", "\u2018", "\u2019"]);
const DOUBLE = new Set(['"', "\u201C", "\u201D"]);
const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}]/u;

// An apostrophe with a letter on both sides is part of the word (couldn't,
// O'Brien), never a quote.
function inWord(text: string, i: number): boolean {
  return LETTER.test(text[i - 1] ?? "") && LETTER.test(text[i + 1] ?? "");
}

/**
 * `text` with every quoted value — single, double or backtick, JSON keys and
 * values alike — replaced by [redacted]. A single quote opens a value only
 * when no letter or digit is right before it, and closes one only when no
 * letter or digit is right after it. A quote not closed on its line takes the
 * rest of the line with it.
 */
export function scrubQuoted(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const single = SINGLE.has(ch);
    const opens =
      (single && !inWord(text, i) && !WORD.test(text[i - 1] ?? "")) || DOUBLE.has(ch) || ch === "`";
    if (!opens) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 1;
    let close = -1;
    while (j < text.length && text[j] !== "\n") {
      const c = text[j];
      const closes = single
        ? SINGLE.has(c) && !inWord(text, j) && !WORD.test(text[j + 1] ?? "")
        : ch === "`"
          ? c === "`"
          : DOUBLE.has(c);
      if (closes) {
        close = j;
        break;
      }
      j += 1;
    }
    if (close < 0) {
      out += REDACTED;
      i = j;
      continue;
    }
    const inner = text.slice(i + 1, close);
    out += KEEP_QUOTED.has(inner) ? text.slice(i, close + 1) : REDACTED;
    i = close + 1;
  }
  return out;
}

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // A database error's parameter list (Drizzle: "Failed query: …\nparams: a,b").
  [/\bparams:\s*[\s\S]*$/gi, "params: [redacted]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[token]"],
  [
    /\b(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|session(?:[_-]?id)?|dsn)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[redacted]",
  ],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // The same written with %40 for the @ (a page address in a message), or
  // %2540 (encoded twice).
  [/[A-Z0-9._%+-]+%(?:25)*40[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/(https?:\/\/[^\s?#"'`]+)[?#][^\s"'`]*/gi, "$1?[query]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]"],
  // IPv6: five or more groups, or a "::" between hex groups (not a clock time).
  [/\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi, "[ip]"],
  // Long tokens: 24+ letters/digits with at least one digit and one letter.
  [/[A-Za-z0-9_+-]{24,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[redacted]" : m)],
  // Phone and card numbers: nine or more digits, with spaces, dashes, dots and
  // brackets between them ("(020) 7946 0958", "07700.900.123"). A leading
  // bracket goes with the number only when the number closes it.
  [/[+(]*\d[\d\s().-]{7,}\d/g, (m) => {
    if (m.replace(/\D/g, "").length < 9) return m;
    const keep = m.startsWith("(") && !m.includes(")") ? "(" : "";
    return `${keep}[number]`;
  }],
];

/** `text` with personal data and secrets replaced, and clipped. */
export function scrubText(text: string | null | undefined, max: number = MAX_MESSAGE): string {
  let out = String(text ?? "");
  for (const [re, to] of RULES) {
    out = out.replace(re, to as never);
  }
  out = scrubQuoted(out);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// A path segment that is an id, not part of the route's shape.
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[0-9]{3,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,}|[^/]*@[^/]*|[^/]*%(?:25)*40[^/]*)$/i;

/** A page path with its query, fragment and id-like segments removed. */
export function scrubPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let p = String(path);
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    // Not a URL: treat as a path.
  }
  p = p.split(/[?#]/)[0];
  const scrubbed = p
    .split("/")
    .map((seg) => (seg && ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
  return scrubText(scrubbed, MAX_TAG) || "/";
}

function frameFilename(file: string): string {
  let f = file.split(/[?#]/)[0];
  const cwd = typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "";
  if (cwd && f.startsWith(cwd)) f = `app://${f.slice(cwd.length)}`;
  f = f.replace(/^file:\/\//, "");
  try {
    if (/^https?:\/\//i.test(f)) f = `app://${new URL(f).pathname}`;
  } catch {
    // keep as is
  }
  return scrubText(f, 300);
}

// "    at fn (file:1:2)", "    at file:1:2", "fn@file:1:2" (Firefox, Safari).
const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Stack frames in Sentry's order (oldest call first), at most 50. */
export function parseStack(stack: string | null | undefined): SentryFrame[] {
  if (!stack) return [];
  const frames: SentryFrame[] = [];
  for (const line of String(stack).split("\n")) {
    const m = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!m) continue;
    const [, fn, file, lineno, colno] = m;
    const filename = frameFilename(file);
    frames.push({
      function: fn ? scrubText(fn, 200) : undefined,
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !/node_modules|^node:|^internal\//.test(file),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** The browser's name and major version from a User-Agent header; nothing else of it. */
export function browserOf(userAgent: string | null | undefined): { name: string; version?: string } | null {
  const ua = userAgent ?? "";
  if (!ua) return null;
  const tests: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [name, re] of tests) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1] };
  }
  return { name: "Other" };
}

// A log field name that holds personal data or a secret never goes.
const PERSONAL_FIELD =
  /(email|e_?mail|name|phone|address|street|postcode|zip|ip|ua|agent|body|message|text|comment|note|query|search|password|secret|token|key|cookie|session|card|iban|account_?number|dob|birth)/i;
const SAFE_CODE = /^[A-Za-z0-9_.:,-]{1,64}$/;

/** The log-line fields that may go: numbers, booleans and short codes only. */
export function safeLogFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (PERSONAL_FIELD.test(name)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[name] = String(value);
    else if (typeof value === "boolean") out[name] = String(value);
    else if (typeof value === "string" && SAFE_CODE.test(value)) {
      const s = scrubText(value, 64);
      if (SAFE_CODE.test(s)) out[name] = s;
    }
  }
  return out;
}

export function tagValue(v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  return scrubText(String(v), MAX_TAG).replace(/\n/g, " ");
}

// An opaque account or tenant id; anything else (an email used as an id) is dropped.
const OPAQUE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
export function opaqueId(v: string | null | undefined): string | null {
  if (!v || !OPAQUE_ID.test(v) || v.includes("@")) return null;
  return v;
}

