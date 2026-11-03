import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm run test:paypal:sandbox`: runs only *.sandbox.test.ts against the real PayPal SANDBOX
// (api-m.sandbox.paypal.com). Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the local env
// file. Never part of `npm test`, which stays fully mocked.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.sandbox.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
