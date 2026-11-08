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

// Quoted text kept because it is plainly a code name, not a value. Only shapes a
// person's name, username, email local part or business slug cannot take:
// a camelCase identifier ('tenantId'), a dotted path with one ('user.tenantId'),
// a module path ('lib/db', 'node:fs'), a CONSTANT_WITH_UNDERSCORE, or an error
// type. A plain lower-case or capitals word ('jane', 'JANE'), a dotted or
// hyphenated one ('jane.doe', 'smith-plumbing') and snake_case ('jane_doe') are
// values, so 'users.email' and 'tenant_id' are dropped too: fault-finding loses a
// little, no customer data goes.
const CAMEL = /^[a-z$][a-z0-9$]*[A-Z][A-Za-z0-9$]*$/;
const CONSTANT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ERROR_TYPE = /^[A-Z][A-Za-z]*(?:Error|Exception)$/;
const MODULE_PATH = /^(?:node:[a-z_/]+|(?:@[a-z0-9-]+\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.[\]-]+)+)$/;
function isCodeName(s: string): boolean {
  if (CAMEL.test(s) || CONSTANT.test(s) || ERROR_TYPE.test(s) || MODULE_PATH.test(s)) return true;
  const parts = s.split(".");
  return parts.length > 1 && parts.every((x) => /^[a-z_$][\w$]*$/.test(x)) && parts.some((x) => CAMEL.test(x));
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
  // The same written with %40 for the @ (a page address in a message).
  [/[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
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
  // Quoted text, unless it is plainly a code name (isCodeName, above) or a
  // JSON-style key (an identifier followed by ":"). A quoted word, name,
  // username, slug or anything else is a value.
  [/"([^"\n]{1,200})"(\s*:)?|'([^'\n]{1,200})'(\s*:)?|`([^`\n]{1,200})`/g, (m, a, ak, b, bk, c) => {
    const inner = a ?? b ?? c ?? "";
    const key = (ak ?? bk) !== undefined && /^[A-Za-z_$][\w$-]*$/.test(inner);
    return key || isCodeName(inner) ? m : `${m[0]}[value]${m[0]}${ak ?? bk ?? ""}`;
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

