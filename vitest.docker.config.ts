import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm run test:db:docker`: runs only *.docker.test.ts against the local Docker Postgres.
// Needs the stack up (docker compose up -d --wait) and DATABASE_URL pointing at it.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.docker.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
