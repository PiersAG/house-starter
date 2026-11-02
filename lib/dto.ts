import "server-only";

// Data-transfer objects: the one way data leaves the server for the browser
// (app-business-core issues 794 and 763, 445; Matt Murphy #31 and #140).
//
// Everything a server component passes to a client component, and everything a
// route answers, is sent to the browser — whether or not the screen shows it.
// So each boundary declares the exact fields that cross it, and only those
// cross:
//
//   const SettingRow = defineDto({ key: z.string(), label: z.string() });
//   <SettingControl setting={SettingRow.from(row)} />       // a client prop
//   return dtoJson(SettingRow, row);                        // a response
//
// `from` keeps the named fields and drops every other one (a whole database row
// goes in, only `key` and `label` come out), and refuses a value missing a
// named field. A nested object is declared the same way, so a row cannot hide
// one level down. dtoJson also marks the answer `Cache-Control: no-store`: a
// signed-in answer is never kept by a browser or a shared cache (issue 445).
//
// tests/unit/data-boundary.test.ts fails a response or a client prop that
// carries a field config/data-classification.ts marks internal or secret, a
// whole table row, or an object not built here or written out field by field.

import { NextResponse } from "next/server";
import { z } from "zod";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export type Dto<S extends z.ZodRawShape> = {
  schema: z.ZodObject<S>;
  /** The named fields of `value`, and nothing else. Throws when one is missing. */
  from(value: unknown): z.infer<z.ZodObject<S>>;
};

/** Declare the fields that cross one server-to-browser boundary. */
export function defineDto<S extends z.ZodRawShape>(shape: S): Dto<S> {
  // z.object strips unknown keys by default — that is the whole point; the
  // shape must never be .passthrough() or .catchall().
  const schema = z.object(shape);
  return { schema, from: (value: unknown) => schema.parse(value) };
}

/** A JSON answer holding exactly the DTO's fields, never cached. */
export function dtoJson<S extends z.ZodRawShape>(
  dto: Dto<S>,
  value: unknown,
  init: ResponseInit = {},
): NextResponse {
  const headers = new Headers(init.headers);
  for (const [name, v] of Object.entries(NO_STORE)) if (!headers.has(name)) headers.set(name, v);
  return NextResponse.json(dto.from(value), { ...init, headers });
}
