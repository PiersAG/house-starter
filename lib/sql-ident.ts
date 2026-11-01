// The only two things that may be spliced into a SQL string
// (app-business-core issue 517; Matt Murphy #42).
//
// Values are never spliced: they go in as bound arguments
// (`client.execute({ sql: "... WHERE id = ?", args: [id] })`) or through
// Drizzle's query builder and its sql`` template, which binds them. What SQL
// cannot bind is a NAME — a table or a column — and, in a migration, a column's
// definition. Those come from the code, never from a request, and each is
// checked here against a strict shape before it is spliced, so even a mistake
// cannot turn one into a second statement.
//
// The factory's security gate fails SQL built from strings
// (factory.sql-built-from-strings) unless every spliced part goes through
// sqlIdent() or sqlColumnDef().

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** A table or column name, checked: letters, digits and underscores only. */
export function sqlIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`lib/sql-ident.ts: ${JSON.stringify(name)} is not a plain SQL identifier.`);
  }
  return name;
}

// A column definition as the migrations write them: a type, then constraints.
const TYPE = String.raw`(TEXT|INTEGER|REAL|NUMERIC)`;
const LITERAL = String.raw`(-?\d+(\.\d+)?|'[A-Za-z0-9_ .:-]*'|NULL|\(unixepoch\(\)\))`;
const CHECK_IN = String.raw`CHECK \([a-z_][a-z0-9_]* IN \('[A-Za-z0-9_ .:-]*'(,\s*'[A-Za-z0-9_ .:-]*')*\)\)`;
const REFERENCES = String.raw`REFERENCES [a-z_][a-z0-9_]*\([a-z_][a-z0-9_]*\)`;
const CONSTRAINT = String.raw`(NOT NULL|UNIQUE|PRIMARY KEY|DEFAULT ${LITERAL}|${CHECK_IN}|${REFERENCES})`;
const COLUMN_DEF = new RegExp(String.raw`^${TYPE}( ${CONSTRAINT})*$`);

/** A column definition from the code's own migration, checked against that grammar. */
export function sqlColumnDef(def: string): string {
  const normalised = def.trim().replace(/\s+/g, " ");
  if (!COLUMN_DEF.test(normalised)) {
    throw new Error(`lib/sql-ident.ts: ${JSON.stringify(def)} is not a column definition this template writes.`);
  }
  return normalised;
}
