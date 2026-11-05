// Every script the built app sends to browsers runs on the oldest supported browser
// (config/browser-support.ts; app-business-core issue 721). Parses each file under
// .next/static with the JavaScript level of that floor and fails on any that needs a
// newer one. Run by the correctness gate after `npm run build`:
//
//   npx tsx scripts/check-browser-floor.ts            # .next/static
//   npx tsx scripts/check-browser-floor.ts <dir>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse, type ecmaVersion } from "acorn";
import { BROWSER_FLOOR } from "../config/browser-support";

export type FloorProblem = { file: string; error: string };

function scripts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...scripts(full));
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(full);
  }
  return out.sort();
}

/** The scripts under `dir` that do not parse at `level`, with the parser's reason. */
export function checkBrowserFloor(
  dir: string,
  level: number = BROWSER_FLOOR.ecmaVersion,
): { checked: number; problems: FloorProblem[] } {
  const files = scripts(dir);
  const problems: FloorProblem[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceType = file.endsWith(".mjs") ? "module" : "script";
    try {
      parse(source, { ecmaVersion: level as ecmaVersion, sourceType });
    } catch (error) {
      problems.push({ file: relative(dir, file), error: (error as Error).message });
    }
  }
  return { checked: files.length, problems };
}

function main(): void {
  const dir = process.argv[2] ?? join(process.cwd(), ".next", "static");
  const { checked, problems } = checkBrowserFloor(dir);
  if (checked === 0) {
    console.error(`No scripts under ${dir}: build the app first (npm run build).`);
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} of ${checked} shipped scripts need JavaScript newer than ES${BROWSER_FLOOR.ecmaVersion}, ` +
        "the level of the oldest supported browsers (config/browser-support.ts):",
    );
    for (const p of problems) console.error(`  ${p.file}: ${p.error}`);
    process.exit(1);
  }
  console.log(`All ${checked} shipped scripts run on ES${BROWSER_FLOOR.ecmaVersion} browsers (config/browser-support.ts).`);
}

if (process.argv[1] && /check-browser-floor\.ts$/.test(process.argv[1])) main();
