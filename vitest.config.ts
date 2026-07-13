import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}", "app/**/*.{test,spec}.{ts,tsx}", "lib/**/*.{test,spec}.{ts,tsx}", "components/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["app/**", "components/**", "lib/**"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        // Server actions tested via E2E, not unit tests:
        "app/**/actions.ts",
        "app/api/**",
        // Server components and page shells — tested via Playwright E2E:
        "app/**/page.tsx",
        "app/**/layout.tsx",
        "app/**/LoginForm.tsx",
        // UI primitive components — tested via E2E accessibility scans:
        "components/ui/**",
      ],
      // SECURITY GATE (spec C4b): per-file 100% thresholds on the
      // security-critical modules. This is the real gate — enforced here,
      // where coverage is actually computed, on real files named by path.
      // There are deliberately NO blanket global thresholds: the rest of the
      // report is informational and must stay truthful, not aspirational.
      thresholds: {
        "**/lib/password.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/rate-limit.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/users.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/db.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
