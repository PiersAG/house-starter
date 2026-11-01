// Input validation for every write path and every query value
// (PiersAG/app-business-core #442 SEC.26a, #517, #758; ASVS V5.1.3/V5.1.4).
//
// One vocabulary of field schemas, used by the server actions, the API routes
// and lib/users.ts alike, so the server enforces the same rules whichever door a
// request comes through — never the browser alone (Matt Murphy #36, #242).
//
//   * Every value is checked for type, format and length BEFORE it reaches
//     business logic or the database; unexpected input is REJECTED, not
//     repaired (Matt Murphy #42).
//   * Every string is cleaned first: Unicode-normalised (NFC), control
//     characters removed, surrounding space trimmed (Matt Murphy #170, "clean
//     every string input before processing"). Passwords are the one exception —
//     they are compared byte for byte, so they are length-checked, not changed.
//   * A form or JSON object is parsed against an object schema: a missing field
//     is rejected, a wrong type is rejected, an unexpected field (role, plan,
//     isAdmin, tenantId…) is stripped and never reaches the code (Matt Murphy
//     #48, #170). `.passthrough()` and `.catchall()` are refused by the
//     factory's security gate, so a schema cannot be quietly widened.
//   * Names and other text that can end up in an email are limited to the
//     characters a name has: no HTML, script, links or markup (Matt Murphy #35).
//
// The factory's security gate fails a server action that reads its FormData
// without one of these parses (factory.server-action-without-schema-validation),
// and an API route or page that reads query or route parameters without one
// (factory.request-params-without-schema-validation).

import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";

/** Longest value any single-line text field accepts unless it says otherwise. */
export const MAX_TEXT_LENGTH = 200;
/** RFC 5321's limit on a whole address. */
export const MAX_EMAIL_LENGTH = 254;
/** A password longer than this is refused before it is hashed (hashing cost). */
export const MAX_PASSWORD_LENGTH = 256;
/** A person's or business's name. */
export const MAX_NAME_LENGTH = 100;

// C0 and C1 control characters, zero-width and bidirectional-override marks.
// Tab and newline are kept only where a field is multi-line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const LINE_BREAKS = /[\t\n\r]/g;

/** Normalise, strip control characters, trim. Single-line unless `multiline`. */
export function cleanText(value: string, { multiline = false } = {}): string {
  let out = value.normalize("NFC").replace(CONTROL, "");
  if (!multiline) out = out.replace(LINE_BREAKS, " ");
  return out.trim();
}

/** A single-line text field: cleaned, then 0..max characters. */
export function textField({ max = MAX_TEXT_LENGTH, min = 0, multiline = false } = {}) {
  return z
    .string()
    .transform((v) => cleanText(v, { multiline }))
    .pipe(z.string().min(min).max(max));
}

/** An email address: cleaned, lower-cased, valid format, at most 254 characters. */
export const emailField = z
  .string()
  .transform((v) => cleanText(v).toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "Enter your email address.")
      .max(MAX_EMAIL_LENGTH, "That email address is too long.")
      .pipe(z.email("Enter a valid email address.")),
  );

/** A new password: not altered, MIN_PASSWORD_LENGTH..MAX_PASSWORD_LENGTH characters. */
export const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`);

/** A password being checked (sign-in, current password): present and not over-long. */
export const passwordField = z
  .string()
  .min(1, "Enter your password.")
  .max(MAX_PASSWORD_LENGTH, "That password is too long.");

// Letters (any script), combining marks, spaces and the punctuation names use.
const NAME_CHARS = /^[\p{L}\p{M}][\p{L}\p{M} .'’,-]*$/u;
const LINK_LIKE = /(:\/\/|www\.|@|\.(com|net|org|io|co|uk|app|dev|xyz|info|biz|me|ly|ru|cn|top)\b)/i;

/**
 * Why a name is refused, or null when it is acceptable. Rejects markup, script,
 * links and anything outside the characters a name has — a name is shown in
 * emails and pages, so it must never carry a login button or a phishing link
 * (Matt Murphy #35).
 */
export function nameProblem(value: string): string | null {
  if (value.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  if (LINK_LIKE.test(value)) return "A name cannot contain a link or an email address.";
  if (!NAME_CHARS.test(value)) {
    return "Use letters, spaces, hyphens, apostrophes and full stops only.";
  }
  return null;
}

/** A person's or business's name: cleaned, 1..100 characters, no markup or links. */
export const nameField = z
  .string()
  .transform((v) => cleanText(v))
  .pipe(
    z
      .string()
      .min(1, "Enter a name.")
      .superRefine((v, ctx) => {
        const problem = nameProblem(v);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
  );

/** An optional name: an empty value is absent (null), anything else is a nameField. */
export const optionalNameField = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? "" : cleanText(v)))
  .pipe(z.union([z.literal("").transform(() => null), nameField]));

/** A random id (crypto.randomUUID) — every id the template issues is one. */
export const idField = z.uuid("That is not a valid id.");

/** An opaque token from a link (password reset): URL-safe characters only. */
export const tokenField = z
  .string()
  .min(16, "This link is incomplete. Request a new one.")
  .max(512, "This link is not valid. Request a new one.")
  .regex(/^[A-Za-z0-9_-]+$/, "This link is not valid. Request a new one.");

/** A settings key as the registry names them: `capability.name`, lower case. */
export const settingKeyField = z
  .string()
  .max(100, "Unknown setting.")
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "Unknown setting.");

/** A checkbox: present ("on", "true", "1") or absent. */
export const checkboxField = z
  .union([z.string(), z.undefined()])
  .transform((v) => v === "on" || v === "true" || v === "1");

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The first issue's message, for a form's single error line. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message || "Check the form and try again.";
}

/**
 * Parse a server action's FormData against an object schema. Each field's first
 * value is taken as text; a file where text was expected is refused. Next.js's
 * own `$ACTION…` fields are dropped; every other field the schema does not name
 * is stripped by the schema.
 */
export function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
): ParseResult<z.output<S>> {
  const raw: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION") || key in raw) continue;
    if (typeof value !== "string") return { ok: false, error: "Unexpected file in the form." };
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: firstIssue(parsed.error) };
}

/**
 * Parse query-string values (URLSearchParams, or a page's `searchParams`)
 * against an object schema. Each key's first value is used; keys the schema
 * does not name are stripped.
 */
export function parseQuery<S extends z.ZodType>(
  schema: S,
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): ParseResult<z.output<S>> {
  const raw: Record<string, string> = {};
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) if (!(key in raw)) raw[key] = value;
  } else {
    for (const [key, value] of Object.entries(params)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string") raw[key] = first;
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: firstIssue(parsed.error) };
}
