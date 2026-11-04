import { defineConfig } from "@playwright/test";
import { APP_PORT, APP_URL, FAKE_PORT, appEnv } from "./tests/e2e/env";

// `npm run test:e2e` runs the demo with its own server on port 3100, its own build folder, a
// throwaway database and fake outside services, so your dev server and data aren't touched. It needs
// Docker running, for the database.
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 5 * 60 * 1000,
  reporter: "line",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: APP_URL, screenshot: "only-on-failure", actionTimeout: 20_000 },
  webServer: [
    {
      command: "npx tsx tests/e2e/fake-services.ts",
      port: FAKE_PORT,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: `npx next dev --hostname 127.0.0.1 --port ${String(APP_PORT)}`,
      cwd: "apps/web",
      port: APP_PORT,
      env: appEnv(),
      timeout: 120 * 1000,
      reuseExistingServer: false,
      stdout: "ignore",
    },
  ],
});
