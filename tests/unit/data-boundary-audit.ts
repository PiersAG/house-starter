// The server-to-browser data boundary, audited with the TypeScript checker
// (app-business-core issues 794, 763 and 445; Matt Murphy #31 and #140).
// Used by tests/unit/data-boundary.test.ts, against the template and against
// seeded examples.
//
// Everything that crosses to the browser is found from the source:
//   * the body of every route answer — NextResponse.json / Response.json /
//     dtoJson / new Response(JSON.stringify(...)) in app/**/route.ts;
//   * what every server action returns (a "use server" file's exports);
//   * every prop a server file passes to a "use client" component.
// Each crossing value must be either a DTO (`X.from(...)`, lib/dto.ts) or an
// object written out field by field down to plain values (text, numbers, true
// or false, lists of those). Then its TYPE is read: it fails if any field, at
// any depth, has a name config/data-classification.ts reserves for internal or
// secret data, or if it carries every column of a table (a whole row).
// Separately: a zero-argument `.select()` or a `findFirst/findMany` without
// `columns` in app/ or components/ reads every column, and a "use client" file
// may not import the database schema at all.

import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DATA_CLASSIFICATION } from "@/config/data-classification";

/** Ordinary words that ALSO name internal columns but name safe fields elsewhere. */
export const SHARED_NAMES = new Set([
  "id", "userId", "tenantId", "key", "value", "label", "version", "status", "message", "type",
  "event", "data", "action", "method", "route", "context", "access", "service", "note",
  "entity", "createdAt", "updatedAt", "expiresAt", "usedAt", "occurredAt",
  // Next.js puts an error `digest` (a short hash standing in for the error's
  // text) into every page's RSC payload by design; the stored error log's
  // column of the same name never leaves the server.
  "digest",
  // Ordinary words that also name internal columns of the payment-dispute table.
  "amount", "reason", "currency",
]);

/** Field names that only ever hold internal or secret data. */
export function bannedFieldNames(): Map<string, string> {
  const safe = new Set<string>();
  const out = new Map<string, string>();
  for (const [table, cols] of Object.entries(DATA_CLASSIFICATION)) {
    for (const [col, c] of Object.entries(cols)) {
      if (c.class === "public" || c.class === "personal") safe.add(col);
      else if (!out.has(col)) out.set(col, `${table}.${col} (${c.class})`);
    }
  }
  for (const name of [...safe, ...SHARED_NAMES]) out.delete(name);
  return out;
}

/** Column-name sets of every table with three or more columns. */
export function tableColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [table, cols] of Object.entries(DATA_CLASSIFICATION)) {
    if (Object.keys(cols).length >= 3) out.set(table, new Set(Object.keys(cols)));
  }
  return out;
}

export type Finding = { file: string; line: number; what: string };

export function programFor(root: string, rootNames?: string[]): ts.Program {
  const configPath = join(root, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true, incremental: false, plugins: [] };
  return ts.createProgram({ rootNames: rootNames ?? parsed.fileNames, options });
}

const DIRECTIVE = (sf: ts.SourceFile, d: string) =>
  sf.statements.length > 0 &&
  ts.isExpressionStatement(sf.statements[0]) &&
  ts.isStringLiteral(sf.statements[0].expression) &&
  sf.statements[0].expression.text === d;

export const isClientFile = (sf: ts.SourceFile) => DIRECTIVE(sf, "use client");
export const isServerActionFile = (sf: ts.SourceFile) => DIRECTIVE(sf, "use server");

/** `crossings`, when given, collects every crossing checked: "file kind name". */
export function audit(program: ts.Program, root: string, crossings: string[] = []): Finding[] {
  const checker = program.getTypeChecker();
  const banned = bannedFieldNames();
  const tables = tableColumns();
  const findings: Finding[] = [];
  const rel = (sf: ts.SourceFile) => relative(root, sf.fileName).replace(/\\/g, "/");
  const report = (node: ts.Node, what: string) => {
    const sf = node.getSourceFile();
    findings.push({ file: rel(sf), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what });
  };

  const isDtoCall = (e: ts.Expression): boolean =>
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "from";

  /** Text, numbers, booleans, null/undefined, dates, and lists of those. */
  const isPlain = (t: ts.Type, depth = 0): boolean => {
    if (depth > 4) return false;
    if (t.isUnion()) return t.types.every((u) => isPlain(u, depth + 1));
    const f = t.getFlags();
    const prim =
      ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void |
      ts.TypeFlags.Never | ts.TypeFlags.EnumLike;
    if (f & prim) return true;
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      return checker.getTypeArguments(t as ts.TypeReference).every((a) => isPlain(a, depth + 1));
    }
    return t.getSymbol()?.getName() === "Date";
  };

  /** Fields of a crossing type, at any depth, named for internal/secret data or forming a whole row. */
  const checkType = (node: ts.Node, t: ts.Type, path: string, depth: number, seen: Set<ts.Type>) => {
    if (depth > 6 || seen.has(t)) return;
    seen.add(t);
    if (t.isUnion() || t.isIntersection()) {
      for (const u of t.types) checkType(node, u, path, depth + 1, seen);
      return;
    }
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      for (const a of checker.getTypeArguments(t as ts.TypeReference)) checkType(node, a, `${path}[]`, depth + 1, seen);
      return;
    }
    if (!(t.getFlags() & ts.TypeFlags.Object) || t.getSymbol()?.getName() === "Date") return;
    const props = checker.getPropertiesOfType(t);
    const names = new Set(props.map((p) => p.getName()));
    for (const [table, cols] of tables) {
      if ([...cols].every((c) => names.has(c))) report(node, `${path || "the value"} is a whole ${table} row — send only the fields the browser needs`);
    }
    for (const p of props) {
      const name = p.getName();
      const why = banned.get(name);
      if (why) report(node, `${path ? `${path}.` : ""}${name} reaches the browser; it is ${why} in config/data-classification.ts`);
      const pt = checker.getTypeOfSymbolAtLocation(p, node);
      checkType(node, pt, path ? `${path}.${name}` : name, depth + 1, seen);
    }
  };

  /** A crossing value: a DTO, or written out field by field down to plain values. */
  const checkValue = (e: ts.Expression, path: string) => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    checkType(e, checker.getTypeAtLocation(e), path, 0, new Set());
    if (isDtoCall(e)) return;
    // A constant object declared in this file is read through its definition.
    if (ts.isIdentifier(e)) {
      const decl = checker.getSymbolAtLocation(e)?.valueDeclaration;
      if (
        decl && ts.isVariableDeclaration(decl) && decl.initializer &&
        decl.getSourceFile() === e.getSourceFile() &&
        ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const &&
        ts.isObjectLiteralExpression(decl.initializer)
      ) {
        return checkValue(decl.initializer, path);
      }
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) report(p, `${path || "the value"} spreads another object in — name each field instead`);
        else if (ts.isPropertyAssignment(p)) checkLeaf(p.initializer, `${path ? `${path}.` : ""}${p.name.getText()}`);
        else if (ts.isShorthandPropertyAssignment(p)) checkLeaf(p.name, `${path ? `${path}.` : ""}${p.name.text}`);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) checkLeaf(el, `${path}[]`);
      return;
    }
    if (!isPlain(checker.getTypeAtLocation(e))) {
      report(e, `${path || "the value"} is an object that is neither a DTO (X.from(...)) nor written out field by field`);
    }
  };
  const checkLeaf = (e: ts.Expression, path: string) => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    if (isDtoCall(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return checkValue(e, path);
    if (!isPlain(checker.getTypeAtLocation(e))) {
      report(e, `${path} is an object that is neither a DTO (X.from(...)) nor written out field by field`);
    }
  };

  const declFile = (tag: ts.JsxTagNameExpression): ts.SourceFile | undefined => {
    let sym = checker.getSymbolAtLocation(tag);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations?.[0]?.getSourceFile();
  };

  for (const sf of program.getSourceFiles()) {
    const file = rel(sf);
    if (sf.isDeclarationFile || file.startsWith("..") || file.startsWith("node_modules/")) continue;
    if (!/^(app|components)\//.test(file)) continue;
    const client = isClientFile(sf);
    const action = isServerActionFile(sf);
    const route = /(^|\/)route\.ts$/.test(file);

    if (client) {
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /(^|\/)lib\/schema$/.test(st.moduleSpecifier.text)) {
          report(st, `a "use client" file imports the database schema — give the component a DTO type instead`);
        }
      }
    }

    const visit = (node: ts.Node) => {
      // Reads of every column in app/ and components/.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const m = node.expression.name.text;
        if (m === "select" && node.arguments.length === 0) {
          report(node, "select() with no field list reads every column — name the columns this page or route uses");
        }
        if ((m === "findFirst" || m === "findMany") && /\.query\./.test(node.expression.getText())) {
          const arg = node.arguments[0];
          const hasColumns = arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name?.getText() === "columns");
          if (!hasColumns) report(node, `${m}() without \`columns\` reads every column — name the columns this page or route uses`);
        }
      }
      // Route answers.
      if (route && ts.isCallExpression(node)) {
        const callee = node.expression.getText();
        if (/^(NextResponse|Response)\.json$/.test(callee) && node.arguments[0]) {
          crossings.push(`${file} answer`);
          checkValue(node.arguments[0], "");
        }
        if (callee === "dtoJson" && node.arguments[0]) {
          crossings.push(`${file} answer`);
          // What the DTO lets through: the return type of its own `from`.
          const from = checker.getTypeAtLocation(node.arguments[0]).getProperty("from");
          const sig = from && checker.getTypeOfSymbolAtLocation(from, node).getCallSignatures()[0];
          if (sig) checkType(node, checker.getReturnTypeOfSignature(sig), "", 0, new Set());
          else report(node, "dtoJson is given something that is not a DTO");
        }
      }
      if (route && ts.isNewExpression(node) && node.expression.getText() === "Response") {
        const a = node.arguments?.[0];
        if (a && ts.isCallExpression(a) && a.expression.getText() === "JSON.stringify" && a.arguments[0]) checkValue(a.arguments[0], "");
      }
      // Server-action returns.
      if (action && ts.isReturnStatement(node) && node.expression) {
        const fn = ts.findAncestor(node, (n) => ts.isFunctionLike(n));
        const top = fn && ts.isFunctionDeclaration(fn) && fn.modifiers?.some((mo) => mo.kind === ts.SyntaxKind.ExportKeyword);
        if (top) {
          crossings.push(`${file} action-return`);
          checkValue(node.expression, "");
        }
      }
      // Props passed from a server file to a client component.
      if (!client && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) {
        const target = declFile(node.tagName);
        if (target && isClientFile(target)) {
          for (const attr of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) report(attr, `props spread into a client component — pass each one by name`);
            else if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
              crossings.push(`${file} prop ${node.tagName.getText()}.${attr.name.getText()}`);
              checkValue(attr.initializer.expression, attr.name.getText());
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

/** Every "use client" file, and every module it reaches through value imports. */
export function clientReach(root: string, files: string[]): Map<string, string[]> {
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const exists = (f: string) => ts.sys.fileExists(join(root, f));
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) base = join(dirname(from), spec).replace(/\\/g, "/");
    else return null;
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(cand) && exists(cand)) return cand;
    }
    return null;
  };
  const valueImports = (f: string): string[] => {
    const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    for (const st of sf.statements) {
      if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        if (ts.isImportDeclaration(st)) {
          const c = st.importClause;
          if (c?.isTypeOnly) continue;
          const nb = c?.namedBindings;
          if (c && !c.name && nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly)) continue;
        } else if (st.isTypeOnly) continue;
        out.push(st.moduleSpecifier.text);
      }
    }
    return out;
  };
  const chains = new Map<string, string[]>();
  for (const entry of files) {
    const stack: string[][] = [[entry]];
    const seen = new Set<string>([entry]);
    while (stack.length) {
      const chain = stack.pop()!;
      const at = chain[chain.length - 1];
      if (!chains.has(at)) chains.set(at, chain);
      // A "use server" file is a reference to the server, not code sent to the browser.
      if (at !== entry && /^['"]use server['"]/.test(read(at).trimStart())) continue;
      for (const spec of valueImports(at)) {
        if (spec === "server-only") continue;
        const next = resolve(at, spec);
        if (next && !seen.has(next)) {
          seen.add(next);
          stack.push([...chain, next]);
        }
      }
    }
  }
  return chains;
}
