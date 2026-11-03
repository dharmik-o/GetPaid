import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    // A few tests start an in-memory Postgres (PGlite, WASM) inside the test itself; with every
    // worker doing that at once, the 5 s default is too tight. Assertions are unchanged.
    testTimeout: 15_000,
    // The same applies to setup hooks that start PGlite (beforeEach in tests/db/runner.test.ts).
    hookTimeout: 15_000,
    // *.docker.test.ts need the local stack (`npm run test:db:docker`); *.sandbox.test.ts call
    // the real PayPal sandbox (`npm run test:paypal:sandbox`). Everything run here is mocked.
    exclude: ["tests/e2e/**", "**/*.docker.test.ts", "**/*.sandbox.test.ts", "**/node_modules/**"],
  },
});
