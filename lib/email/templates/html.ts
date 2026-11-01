// Email HTML that encodes by default (app-business-core issue 758; Matt Murphy
// #35, "use template engines that encode output by default").
//
// Every email template builds its HTML with the `html` tag. Each value placed
// in it is escaped as text unless it is itself `html` output, so a value from a
// user — a name, a business name, a message — can only ever appear as inert
// text: never a tag, a link, a button or a script. Links, buttons and every
// other piece of markup stay fixed in the server-side template; user input
// fills text-only placeholders. The one way to put a URL into an attribute is
// `safeUrl()`, which accepts only http(s) addresses (no `javascript:`), and
// whose result is escaped like any other value.
//
// The factory's security gate fails an email template that builds HTML in an
// untagged template string (factory.email-html-without-encoding), so a new
// template cannot fall back to hand-escaping one value at a time.

const SAFE = Symbol("safe-html");

/** A fragment of HTML the template itself wrote (or `html` built). */
export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
}

function isSafe(v: unknown): v is SafeHtml {
  return typeof v === "object" && v !== null && (v as SafeHtml)[SAFE] === true;
}

/** Escape a string for HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Value = string | number | SafeHtml | null | undefined | readonly Value[];

function render(v: Value): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (isSafe(v)) return v.value;
  return escapeHtml(String(v));
}

/**
 * The tag every email template uses: literal parts are the template's own
 * markup, every `${value}` is escaped unless it is `html` output.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return { [SAFE]: true, value: out };
}

/**
 * A URL for an href: only absolute http(s) addresses pass; anything else
 * (javascript:, data:, a relative path, junk) throws, because a template that
 * links somewhere must know where. The result is escaped when placed.
 */
export function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("lib/email/templates/html.ts: an email link must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`lib/email/templates/html.ts: refusing a ${parsed.protocol} link in an email.`);
  }
  return parsed.toString();
}
