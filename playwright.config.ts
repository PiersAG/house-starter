import { defineConfig, devices } from "@playwright/test";

// Spec C4 — responsive breakpoint contract. Every app must render correctly
// at each of these widths. Kept here (not in a shared file) because the
// Playwright config is the source of truth for the gate itself.
const RESPONSIVE_VIEWPORTS = [
  { name: "responsive-320-small-phone", viewport: { width: 320, height: 640 } },
  // 390 uses a real touch/mobile device profile per Spec C4 §D.1
  // ("at least one genuine mobile device profile — touch, not just a narrow desktop window").
  { name: "responsive-390-phone", device: devices["iPhone 12"] },
  { name: "responsive-768-tablet", viewport: { width: 768, height: 1024 } },
  { name: "responsive-1280-laptop", viewport: { width: 1280, height: 800 } },
  { name: "responsive-1920-desktop", viewport: { width: 1920, height: 1080 } },
] as const;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testDir: "./tests/e2e",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Tenant-isolation project — spec: wiki/specs/stage0-tenant-isolation.md.
      // Kept as its own project so `test:isolation` runs only these specs and
      // `test:e2e` runs only the e2e smoke suite; both share the same webServer.
      name: "isolation",
      testDir: "./tests/isolation",
      use: { ...devices["Desktop Chrome"] },
    },
    // Spec C4 — multi-viewport advisory gate.
    // Every project runs the same responsive.spec.ts, so the single suite
    // executes five times, once per gated width.
    ...RESPONSIVE_VIEWPORTS.map((v) => ({
      name: v.name,
      testDir: "./tests/responsive",
      use:
        "device" in v
          ? { ...v.device }
          : { ...devices["Desktop Chrome"], viewport: v.viewport },
    })),
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
