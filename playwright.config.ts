import { defineConfig } from "@playwright/test";

// Needs the dev server running first: `npm run dev`.
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3000" },
});
