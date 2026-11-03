import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    // *.docker.test.ts need the local stack; run them with `npm run test:db:docker`.
    exclude: ["tests/e2e/**", "**/*.docker.test.ts", "**/node_modules/**"],
  },
});
