// Script-execution gate (spec: wiki/specs/csp-nonce-hydration-fix.md, Deliverable C).
//
// Two checks — both required, both fail-closed. A 200 response with a nonce
// CSP header but no nonce on scripts must FAIL. Same for a page that renders
// but whose client scripts do not execute (CSP violation, hydration miss).
//
//   (a) CSP-header parity — every <script> tag in the served HTML carries a
//       nonce attribute that matches the CSP header's script-src nonce-XXX.
//   (b) Live script execution — a trivial client interaction (password eye
//       toggle) actually flips state on /login, and NO CSP violations are
//       reported by the browser during either route load.

import { test, expect, type Page } from "@playwright/test";

const ROUTES = ["/", "/login"] as const;

function extractNonceFromCsp(csp: string | null): string {
  if (!csp) throw new Error("no CSP header on response");
  const match = csp.match(/'nonce-([^']+)'/);
  if (!match) throw new Error(`CSP has no nonce directive: ${csp}`);
  return match[1];
}

function attachCspViolationCollector(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" &&
      /Content Security Policy|Refused to execute inline script|Refused to load the script/i.test(
        text,
      )
    ) {
      violations.push(text);
    }
  });
  page.on("pageerror", (err) => {
    if (/Content Security Policy/i.test(err.message)) {
      violations.push(err.message);
    }
  });
  return violations;
}

for (const route of ROUTES) {
  test(`CSP nonce parity: every <script> on ${route} carries the header's nonce`, async ({
    request,
  }) => {
    const res = await request.get(route);
    expect(res.status(), `${route} did not return 200`).toBe(200);

    const csp = res.headers()["content-security-policy"] ?? null;
    const headerNonce = extractNonceFromCsp(csp);

    const html = await res.text();
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(
      scriptTags.length,
      `no <script> tags served on ${route} — cannot verify nonce parity`,
    ).toBeGreaterThan(0);

    const missingNonce: string[] = [];
    const wrongNonce: string[] = [];
    for (const tag of scriptTags) {
      const nonceMatch = tag.match(/\bnonce=(?:"([^"]*)"|'([^']*)')/);
      if (!nonceMatch) {
        missingNonce.push(tag.slice(0, 120));
        continue;
      }
      const scriptNonce = nonceMatch[1] ?? nonceMatch[2];
      if (scriptNonce !== headerNonce) {
        wrongNonce.push(
          `expected ${headerNonce}, got ${scriptNonce} — ${tag.slice(0, 120)}`,
        );
      }
    }

    expect(
      missingNonce,
      `scripts on ${route} missing nonce attr:\n${missingNonce.join("\n")}`,
    ).toEqual([]);
    expect(
      wrongNonce,
      `scripts on ${route} have wrong nonce:\n${wrongNonce.join("\n")}`,
    ).toEqual([]);
  });
}

test("client scripts actually execute on /login (password eye toggle)", async ({
  page,
}) => {
  const violations = attachCspViolationCollector(page);

  await page.goto("/login");
  const password = page.getByLabel("Password", { exact: true });
  const showBtn = page.getByRole("button", { name: "Show password" });

  await expect(password).toHaveAttribute("type", "password");
  await showBtn.click();
  await expect(password).toHaveAttribute("type", "text");

  expect(
    violations,
    `CSP violations reported on /login:\n${violations.join("\n")}`,
  ).toEqual([]);
});

test("home page loads without CSP violations", async ({ page }) => {
  const violations = attachCspViolationCollector(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  expect(
    violations,
    `CSP violations reported on /:\n${violations.join("\n")}`,
  ).toEqual([]);
});
