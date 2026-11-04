import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    // Many tests start an in-memory Postgres (PGlite, WASM) and run every migration, with each
    // worker doing it at once. With Docker's stack and a dev server running too, 15 s was too
    // tight. This is setup time only: assertions are unchanged, and a slow test still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // *.docker.test.ts need the local stack (`npm run test:db:docker`); *.sandbox.test.ts call
    // the real PayPal sandbox (`npm run test:paypal:sandbox`). Everything run here is mocked.
    exclude: ["tests/e2e/**", "**/*.docker.test.ts", "**/*.sandbox.test.ts", "**/node_modules/**"],
  },
});
