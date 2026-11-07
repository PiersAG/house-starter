// @vitest-environment node
// The oldest-browser check (app-business-core issue 721, R1274 "the oldest browser").
// scripts/check-browser-floor.ts runs on the real build in the correctness gate; this
// proves it passes what the floor runs and fails what it does not.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBrowserFloor } from "../../scripts/check-browser-floor";
import { BROWSER_FLOOR } from "../../config/browser-support";

const made: string[] = [];
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-floor-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the oldest supported browser runs every shipped script", () => {
  it("the floor is ES2020: Chrome and Edge 80, Firefox 74, Safari 13.1", () => {
    expect(BROWSER_FLOOR.ecmaVersion).toBe(2020);
    expect(BROWSER_FLOOR.browsers.chrome).toMatch(/^80 /);
    expect(BROWSER_FLOOR.browsers.firefox).toMatch(/^74 /);
    expect(BROWSER_FLOOR.browsers.safari).toMatch(/^13\.1 /);
  });

  it("passes ES2020 syntax (optional chaining, nullish coalescing, BigInt)", () => {
    const dir = folder({ "chunks/a.js": "var a = b?.c ?? 1n; async function f(){ for await (const x of y) {} }" });
    expect(checkBrowserFloor(dir)).toEqual({ checked: 1, problems: [] });
  });

  it("fails syntax newer than the floor, naming the file", () => {
    const dir = folder({
      "chunks/ok.js": "var a = 1;",
      "chunks/es2021.js": "a ||= b;",
      "chunks/es2022.js": "class A { #x = 1 }",
    });
    const { checked, problems } = checkBrowserFloor(dir);
    expect(checked).toBe(3);
    expect(problems.map((p) => p.file).sort()).toEqual(["chunks/es2021.js", "chunks/es2022.js"]);
  });

  it("reads files in nested folders and ignores files that are not scripts", () => {
    const dir = folder({ "a/b/c.js": "let x = 1;", "a/b/style.css": "a ||= b" });
    expect(checkBrowserFloor(dir).checked).toBe(1);
  });
});
