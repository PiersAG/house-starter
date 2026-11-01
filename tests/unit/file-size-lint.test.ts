// File-size, function-size and naming rules for generated code (app-business-core
// issue 512; Matt Murphy #22). Acceptance: a seeded oversized file is flagged;
// the clean template is not. Run through ESLint's own API with the template's
// real config, so what is tested is what `npm run lint` enforces.

import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.map((m) => m.ruleId);
}

describe("file-size limit (issue 512)", () => {
  it("a seeded file with over 400 lines of code fails", async () => {
    const body = Array.from({ length: 420 }, (_, i) => `export const value${i} = ${i};`).join("\n");
    expect(await lint(body, "lib/seeded-oversized.ts")).toContain("max-lines");
  }, 30_000);

  it("comments and blank lines do not count", async () => {
    const body = ["export const one = 1;", ...Array.from({ length: 500 }, () => "// a comment"), ""].join("\n\n");
    expect(await lint(body, "lib/seeded-commented.ts")).not.toContain("max-lines");
  }, 30_000);

  it("a function with over 200 lines of code fails", async () => {
    const lines = Array.from({ length: 210 }, (_, i) => `  total += ${i};`).join("\n");
    const body = `export function longOne(): number {\n  let total = 0;\n${lines}\n  return total;\n}\n`;
    expect(await lint(body, "lib/seeded-long-function.ts")).toContain("max-lines-per-function");
  }, 30_000);

  it("names follow the convention", async () => {
    expect(await lint("export function Bad_Name(): number { return 1; }\n", "lib/seeded-name.ts")).toContain(
      "@typescript-eslint/naming-convention",
    );
    expect(await lint("export type lower_type = { a: number };\n", "lib/seeded-type.ts")).toContain(
      "@typescript-eslint/naming-convention",
    );
    expect(await lint("export const MAX_SIZE = 3;\nexport function goodName(): number { return MAX_SIZE; }\n", "lib/seeded-ok.ts")).toEqual([]);
  }, 30_000);
});
