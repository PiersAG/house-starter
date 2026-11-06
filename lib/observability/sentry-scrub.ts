// Stripping personal data and secrets from what goes to Sentry
// (PiersAG/app-business-core#761). The rules are listed in
// lib/observability/sentry.ts's header; tests/unit/sentry-scrub.test.ts holds
// each one. Pure: no server import, no I/O.

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

const CODE_NAME = /^(?:[a-z_$][\w$]*(?:[./:-][\w$]+)*|[A-Z][A-Z0-9_]+|[A-Z][A-Za-z]*(?:Error|Exception))$/;

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
  [/(https?:\/\/[^\s?#"'`]+)[?#][^\s"'`]*/gi, "$1?[query]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]"],
  // IPv6: five or more groups, or a "::" between hex groups (not a clock time).
  [/\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi, "[ip]"],
  // Long tokens: 24+ letters/digits with at least one digit and one letter.
  [/[A-Za-z0-9_+-]{24,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[redacted]" : m)],
  // Phone and card numbers: nine or more digits, spaces and dashes allowed.
  [/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m)],
  // Quoted text, unless it is plainly a code name: a lower-case identifier or
  // dotted/slashed path ('tenantId', "users.email", 'lib/db'), a CONSTANT, or
  // an error type. A quoted name ('Jane'), words or anything else is a value.
  [/"([^"\n]{1,200})"|'([^'\n]{1,200})'|`([^`\n]{1,200})`/g, (m, a, b, c) => {
    const inner = a ?? b ?? c ?? "";
    return CODE_NAME.test(inner) ? m : `${m[0]}[value]${m[0]}`;
  }],
];

/** `text` with personal data and secrets replaced, and clipped. */
export function scrubText(text: string | null | undefined, max: number = MAX_MESSAGE): string {
  let out = String(text ?? "");
  for (const [re, to] of RULES) {
    out = out.replace(re, to as never);
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// A path segment that is an id, not part of the route's shape.
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[0-9]{3,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,}|[^/]*@[^/]*|[^/]*%40[^/]*)$/i;

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

