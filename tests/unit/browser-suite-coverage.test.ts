// @vitest-environment node
// The accessibility and awkward-input suites cover EVERY page and EVERY form, by
// construction (app-business-core issues 720 and 721). The suites read their lists from
// tests/support/routes.ts and tests/support/forms.ts; this fails the build the moment a
// page or form exists under app/ that a list does not name, so "every" never depends on
// someone remembering to add the new screen.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_ROUTES, discoverPageRoutes, visitedRoutes } from "../support/routes";
import { FORMS, UNMOUNTED_FORM_COMPONENTS } from "../support/forms";

const ROOT = join(__dirname, "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}
const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

describe("every page is in the accessibility suite", () => {
  const discovered = discoverPageRoutes(join(ROOT, "app"));

  it("finds the pages", () => {
    expect(discovered.length).toBeGreaterThan(15);
  });

  it("every page under app/ is listed in tests/support/routes.ts", () => {
    expect(discovered.filter((r) => !(r in PAGE_ROUTES))).toEqual([]);
  });

  it("every listed page exists", () => {
    expect(Object.keys(PAGE_ROUTES).filter((r) => !discovered.includes(r))).toEqual([]);
  });

  it("a page left out says why, and only the test-only crash page is left out", () => {
    const skipped = Object.entries(PAGE_ROUTES).filter(([, r]) => r.skip);
    expect(skipped.map(([path]) => path)).toEqual(["/crash-check"]);
    for (const [, r] of skipped) expect(r.skip!.length).toBeGreaterThan(20);
    expect(visitedRoutes().length).toBe(discovered.length - skipped.length);
  });

  it("each visit address is the page itself (plus only a query string)", () => {
    for (const [path, r] of Object.entries(PAGE_ROUTES)) expect(r.visit.split("?")[0]).toBe(path);
  });
});

describe("every form is in the awkward-input suite", () => {
  const appFiles = files(join(ROOT, "app"));
  const withForm = appFiles.filter((f) => /<form\b/.test(readFileSync(f, "utf8"))).map(rel);

  it("finds the forms", () => {
    expect(withForm.length).toBeGreaterThan(5);
  });

  it("every file under app/ that renders a <form> is named in tests/support/forms.ts", () => {
    const covered = new Set(Object.values(FORMS).map((f) => f.source));
    expect(withForm.filter((f) => !covered.has(f))).toEqual([]);
  });

  it("every listed form's file exists and renders a form", () => {
    for (const f of Object.values(FORMS)) {
      expect(existsSync(join(ROOT, f.source)), f.source).toBe(true);
      expect(readFileSync(join(ROOT, f.source), "utf8"), f.source).toMatch(/<form\b/);
    }
  });

  it("every listed form's page is a real page", () => {
    for (const f of Object.values(FORMS)) expect(PAGE_ROUTES[f.path.split("?")[0]], f.path).toBeDefined();
  });

  it("a form component no page mounts stays unmounted until it is listed", () => {
    for (const [component, reason] of Object.entries(UNMOUNTED_FORM_COMPONENTS)) {
      expect(reason.length).toBeGreaterThan(10);
      const name = component.split("/").pop()!.replace(/\.tsx$/, "");
      const importers = appFiles.filter((f) => new RegExp(`from ["'][^"']*${name}["']`).test(readFileSync(f, "utf8")));
      expect(importers.map(rel), `${component} is mounted: add it to FORMS`).toEqual([]);
    }
  });
});
