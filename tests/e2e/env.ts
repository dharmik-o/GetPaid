import { resolve } from "node:path";

// Everything the E2E's own server runs with. All of it is fake and safe to commit. With
// E2E_FAKE_URL set, next.config.mjs doesn't load your local env file at all.

export const APP_PORT = 3100;
export const FAKE_PORT = 3101;
export const DB_PORT = 5433;

export const APP_URL = `http://127.0.0.1:${String(APP_PORT)}`;
export const FAKE_URL = `http://127.0.0.1:${String(FAKE_PORT)}`;
export const DATABASE_URL = `postgres://e2e:e2e-only@127.0.0.1:${String(DB_PORT)}/e2e`;

export const INTERNAL_TOKEN = "e2e-internal-token-not-a-secret-0123456789";
export const ENCRYPTION_KEY = "e2e0".repeat(16);
export const TELEGRAM_CHAT_ID = 777001;
/** The only address the E2E's sender may mail: the seeded client's. */
export const CLIENT_EMAIL = "hudson-street-bakery@example.test";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the clock starts: the next day at 15:00 UTC, which is inside the 9:00 to 17:00 New York
 * window all year. This makes the run the same at any hour, using DEMO_CLOCK_OFFSET_DAYS.
 */
export const startOfRun = (real: Date = new Date()): Date => {
  // Worked out once and kept in the environment, which the test workers inherit, so a run that
  // crosses midnight UTC can't disagree with itself.
  const pinned = process.env.E2E_START;
  if (pinned) return new Date(pinned);
  const start = new Date(real);
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(15, 0, 0, 0);
  process.env.E2E_START = start.toISOString();
  return start;
};

export const offsetDaysTo = (target: Date, real: Date = new Date()): number =>
  (target.getTime() - real.getTime()) / DAY_MS;

export const appEnv = (real: Date = new Date()): Record<string, string> => ({
  NODE_OPTIONS: `--require ${resolve("tests/e2e/fake-network.cjs")}`,
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
  E2E_FAKE_URL: FAKE_URL,
  DATABASE_URL,
  ENCRYPTION_KEY,
  PAYPAL_CLIENT_ID: "e2e-paypal-id",
  PAYPAL_CLIENT_SECRET: "e2e-paypal-secret",
  PAYPAL_WEBHOOK_ID: "WH-FAKE-0001",
  INTERNAL_API_TOKEN: INTERNAL_TOKEN,
  TELEGRAM_BOT_USERNAME: "e2e_bot",
  GMAIL_CLIENT_ID: "e2e-gmail-id",
  GMAIL_CLIENT_SECRET: "e2e-gmail-secret",
  DEV_EMAIL_ALLOWLIST: CLIENT_EMAIL,
  APP_PUBLIC_URL: APP_URL,
  DEMO_CLOCK_OFFSET_DAYS: String(offsetDaysTo(startOfRun(real), real)),
});
