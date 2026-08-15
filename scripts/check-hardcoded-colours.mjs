#!/usr/bin/env node
/**
 * Hardcoded-colour gate — keeps app/ and components/ on the token layer.
 *
 * WHY THIS EXISTS. Every colour in this template is meant to resolve through a
 * design token (`bg-primary` -> `hsl(var(--primary))` -> the value in
 * app/globals.css). A component that writes `bg-blue-600` instead compiles to a
 * literal colour that NO token can reach, so swapping the palette silently
 * leaves that surface on its old colour. The failure is invisible: the app
 * still builds, the tests still pass, and only a human eye on the rendered page
 * notices that the support widget stayed blue while everything else went green.
 * That is exactly what had happened here — the whole SupportWidget plus four
 * primary buttons were outside the token layer.
 *
 * SCOPE. `app/` and `components/` only — the surfaces a theme is supposed to
 * reach. Three deliberate carve-outs:
 *
 *   - `lib/` is NOT scanned, which is what keeps `lib/email/templates/*` out.
 *     Email clients do not reliably support CSS custom properties, so email
 *     colour genuinely cannot reference `:root` tokens the way app components
 *     do. Converting those templates would break the emails. Handled as its own
 *     slice; see docs/theming.md.
 *   - Test and story files are skipped: asserting on a literal colour is the
 *     normal way to test that a token resolved correctly.
 *   - A `theme-exempt: <reason>` comment exempts the line it sits on and the
 *     line immediately below it (eslint-disable-next-line's shape), and every
 *     exemption is REPORTED on each run — so a justified exception (a modal
 *     scrim, say) stays visible in the gate output rather than being buried in
 *     an allowlist inside this script, where nobody would ever read it again.
 *
 * Run standalone:  node scripts/check-hardcoded-colours.mjs
 * Enforced in CI:  tests/unit/hardcoded-colours.test.ts (runs with the rest of
 *                  the design-token contract).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories scanned. Everything else — lib/, tests/, scripts/ — is out. */
export const SCANNED_DIRS = ["app", "components"];

/** Extensions scanned. `.css` is included so a stylesheet cannot smuggle one in. */
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css"];

/** Files exempt by name: colour literals are legitimate test data. */
const SKIP_FILE = /\.(test|spec|stories)\.[jt]sx?$/;

/**
 * globals.css is the token DEFINITION file — it is the one place a raw colour
 * value belongs, and design-tokens.test.ts already governs its format.
 */
const SKIP_PATHS = new Set(["app/globals.css"]);

/**
 * The marker that opts a line out, with its reason kept on the same line.
 * It covers its own line AND the one immediately below, so a class string can
 * be exempted by a comment sitting directly above it.
 */
const EXEMPT_MARKER = "theme-exempt:";

/** Tailwind's built-in palette — the families a token can never reach. */
const PALETTE = [
  "slate", "gray", "grey", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
].join("|");

/** Utilities that take a colour. */
const COLOUR_UTILITIES = [
  "bg", "text", "border", "ring", "ring-offset", "divide", "outline", "shadow",
  "fill", "stroke", "placeholder", "caret", "accent", "decoration",
  "from", "via", "to",
].join("|");

const RULES = [
  {
    id: "palette-class",
    // e.g. bg-blue-600, hover:text-red-500, focus:ring-blue-400/50
    pattern: new RegExp(`\\b(?:${COLOUR_UTILITIES})-(?:${PALETTE})-(?:50|\\d{2,3})\\b`, "g"),
    hint: "use a semantic token class (bg-primary, text-destructive, border-border, …)",
  },
  {
    id: "absolute-white-black",
    // e.g. text-white, bg-black/80 — absolute colours no theme can move.
    pattern: new RegExp(`\\b(?:${COLOUR_UTILITIES})-(?:white|black)\\b`, "g"),
    hint: "use the paired foreground/surface token (text-primary-foreground, bg-card, …)",
  },
  {
    id: "raw-hex",
    // e.g. #fff, #1d4ed8, #1d4ed8cc
    pattern: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
    hint: "move the value into a token in app/globals.css and reference it",
  },
  {
    id: "raw-colour-function",
    // e.g. rgb(29 78 216), hsl(224 76% 48%) — but NOT hsl(var(--primary)).
    pattern: /\b(?:rgba?|hsla?)\(\s*(?!var\()/g,
    hint: "reference a token — hsl(var(--token)) — rather than a literal colour",
  },
];

/** Recursively list scannable files under `dir`. */
function walk(dir, root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional directory (e.g. a capability removed by a flag)
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, root, out);
    } else if (EXTENSIONS.some((e) => entry.endsWith(e)) && !SKIP_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan the tree at `root`.
 *
 * @returns {{violations: Array<{file: string, line: number, match: string, rule: string, hint: string, text: string}>,
 *            exemptions: Array<{file: string, line: number, reason: string}>,
 *            filesScanned: number}}
 */
export function scanForHardcodedColours(root) {
  const violations = [];
  const exemptions = [];
  let filesScanned = 0;

  for (const dir of SCANNED_DIRS) {
    for (const file of walk(resolve(root, dir), root)) {
      const rel = relative(root, file).split(sep).join("/");
      if (SKIP_PATHS.has(rel)) continue;
      filesScanned++;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        const exemptAt = text.indexOf(EXEMPT_MARKER);
        if (exemptAt !== -1) {
          exemptions.push({
            file: rel,
            line: i + 1,
            reason: text.slice(exemptAt + EXEMPT_MARKER.length).trim().replace(/\*\/\s*$/, "").trim(),
          });
          return;
        }
        // Covered by a marker on the line above.
        if (i > 0 && lines[i - 1].includes(EXEMPT_MARKER)) return;
        for (const rule of RULES) {
          rule.pattern.lastIndex = 0;
          let m;
          while ((m = rule.pattern.exec(text)) !== null) {
            violations.push({
              file: rel,
              line: i + 1,
              match: m[0],
              rule: rule.id,
              hint: rule.hint,
              text: text.trim(),
            });
          }
        }
      });
    }
  }

  return { violations, exemptions, filesScanned };
}

/** Human-readable failure text, shared by the CLI and the test. */
export function formatViolations(violations) {
  return violations
    .map((v) => `  ${v.file}:${v.line}  ${v.match}  [${v.rule}] — ${v.hint}`)
    .join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
  const { violations, exemptions, filesScanned } = scanForHardcodedColours(root);

  for (const e of exemptions) {
    console.log(`exempt  ${e.file}:${e.line}  ${e.reason || "(no reason given)"}`);
  }

  if (violations.length > 0) {
    console.error(
      `\nHardcoded colours found in ${SCANNED_DIRS.join("/ and ")}/ ` +
        `(${violations.length} in ${filesScanned} files scanned):\n`,
    );
    console.error(formatViolations(violations));
    console.error(
      `\nThese colours cannot be reached by a theme swap. Convert them to the ` +
        `tokens defined in app/globals.css, or mark a justified exception with a ` +
        `"${EXEMPT_MARKER} <reason>" comment on the line.\n`,
    );
    process.exit(1);
  }

  console.log(`OK — no hardcoded colours in ${filesScanned} files across ${SCANNED_DIRS.join(", ")}/.`);
}
