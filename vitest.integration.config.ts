import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests hit real external services (Stripe test mode) and are NOT
// part of the default `vitest run` (that config's `include` is unit-only). They
// run via `npm run test:integration`, and each suite self-skips when its
// credential is absent, so the command is green with or without a real key.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.{test,spec}.ts"],
    // Real network + Stripe test-clock advances are slow.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // These suites talk to a shared external account; run them serially.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
