// User input in every outgoing email is inert text (app-business-core issue 758;
// Matt Murphy #35).
//
//   * Templates encode by default: every value placed in `html` is escaped
//     unless it is html output — tested with HTML, encoded markup, URLs and
//     script-like values in every placeholder of every template.
//   * Links and buttons are fixed in the server-side template: the only links
//     in a rendered email are the template's own, and only http(s).
//   * The email-producing form (forgot password) is driven end to end with the
//     same values and the DELIVERED message — what the send path hands the
//     provider, captured in log mode — is checked, not only the render.
//   * Names are refused at sign-up when they carry markup or links
//     (tests/unit/input-validation.test.ts), so they never reach a template.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { registerUser, type AppDatabase } from "@/lib/users";
import { requestPasswordReset } from "@/lib/password-reset";
import { clearCapturedEmails, getCapturedEmails } from "@/lib/email/send";
import { html, safeUrl } from "@/lib/email/templates/html";
import { renderLayout } from "@/lib/email/templates/layout";
import { resetPasswordTemplate } from "@/lib/email/templates/reset-password";
import { HOSTILE_TEXT } from "./hostile-input";

/** Every `<a` in the HTML, by its href. */
function links(out: string): string[] {
  return [...out.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((m) => m[1]);
}

/** No live markup came from the value: no tag it opened, no handler, no script. */
function assertInert(out: string, value: string) {
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/<img/i);
  expect(out).not.toMatch(/<b>/i);
  expect(out).not.toMatch(/<[^>]*\son\w+=/i);
  if (/[<>"&]/.test(value)) expect(out).not.toContain(value);
}

describe("the html tag encodes every value by default", () => {
  it("escapes HTML, encoded markup, URLs and script-like values", () => {
    for (const value of HOSTILE_TEXT) {
      const out = html`<p>Hello ${value}</p>`.value;
      assertInert(out, value);
      expect(links(out)).toEqual([]);
    }
    // encoded markup stays encoded (it is not decoded into a tag)
    expect(html`${"&lt;b&gt;"}`.value).toBe("&amp;lt;b&amp;gt;");
  });

  it("keeps the template's own markup and nested html output", () => {
    const inner = html`<strong>${"<i>x</i>"}</strong>`;
    expect(html`<p>${inner}</p>`.value).toBe("<p><strong>&lt;i&gt;x&lt;/i&gt;</strong></p>");
  });

  it("safeUrl accepts only absolute http(s) links", () => {
    expect(safeUrl("https://app.example/reset?token=abc")).toBe("https://app.example/reset?token=abc");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "/relative", "not a url", "vbscript:x"]) {
      expect(() => safeUrl(bad), bad).toThrow();
    }
  });
});

describe("every template: links fixed, values inert", () => {
  it("reset-password, with a hostile value in every placeholder", () => {
    for (const value of HOSTILE_TEXT) {
      const msg = resetPasswordTemplate.render({ resetUrl: "https://app.example/reset-password?token=t", appName: value });
      assertInert(msg.html, value);
      expect(links(msg.html)).toEqual([
        "https://app.example/reset-password?token=t",
        "https://app.example/reset-password?token=t",
      ]);
    }
  });

  it("refuses a non-http link rather than rendering it", () => {
    expect(() => resetPasswordTemplate.render({ resetUrl: "javascript:alert(1)" })).toThrow();
  });

  it("the layout escapes its title and preview text", () => {
    for (const value of HOSTILE_TEXT) {
      const out = renderLayout({ title: value, previewText: value, bodyHtml: html`<p>x</p>` });
      assertInert(out, value);
      expect(links(out)).toEqual([]);
    }
  });

  it("every template file builds its HTML with the html tag", () => {
    const dir = "lib/email/templates";
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "html.ts")) {
      const src = readFileSync(join(dir, f), "utf8");
      // an untagged template string holding markup and a value is hand-built HTML
      const untagged = src.match(/(?<![\w.])`[^`]*<[a-z][^`]*\$\{[^`]*`/gi) ?? [];
      expect(untagged, f).toEqual([]);
    }
  });
});

describe("the email-producing form, end to end: the delivered message is inert", () => {
  let client: Client;
  let db: AppDatabase;
  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
    clearCapturedEmails();
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.EMAIL_SEND_MODE;
  });
  afterEach(() => {
    client.close();
    vi.restoreAllMocks();
  });

  it("forgot password with hostile values sends nothing for an unknown address", async () => {
    for (const value of HOSTILE_TEXT) {
      await requestPasswordReset(db, value, { baseUrl: "https://app.example" });
    }
    expect(getCapturedEmails()).toEqual([]);
  });

  it("forgot password for a real account: the delivered message links only to the app", async () => {
    for (const [i, value] of HOSTILE_TEXT.entries()) {
      // one account per value: each account may ask for three links an hour (issue 515)
      const email = `owner${i}@example.com`;
      await registerUser(db, { email, password: "long enough pw", name: "Ann" });
      clearCapturedEmails();
      await requestPasswordReset(db, email, { baseUrl: "https://app.example", appName: value });
      const sent = getCapturedEmails();
      expect(sent).toHaveLength(1);
      assertInert(sent[0].html, value);
      const hrefs = links(sent[0].html);
      expect(hrefs).toHaveLength(2);
      for (const h of hrefs) expect(h.startsWith("https://app.example/reset-password?token=")).toBe(true);
    }
  }, 60_000);
});
