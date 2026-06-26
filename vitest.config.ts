import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Native addons (better-sqlite3) fail to load under Vitest's default
    // parallel/forked worker pool. Run test files in a single forked process
    // so the native .node binary loads once and cleanly. Database test files
    // additionally set `// @vitest-environment node` to override jsdom.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}", "app/**/*.{test,spec}.{ts,tsx}", "lib/**/*.{test,spec}.{ts,tsx}", "components/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["app/**", "components/**", "lib/**"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        // Stubs replaced per-app — tested indirectly via integration tests:
        "lib/db.ts",
        "lib/auth.ts",
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
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 70,
        functions: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
