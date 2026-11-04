// The app's one clock. In development DEMO_CLOCK_OFFSET_DAYS moves it forward, so a demo can jump
// days ahead; in production it's always the real time. A jump from Settings wins over the env value
// until the server restarts. Tokens and PayPal's own times keep using the real clock.

type ClockEnv = Partial<Record<"NODE_ENV" | "DEMO_CLOCK_OFFSET_DAYS", string>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;
export const MAX_OFFSET_DAYS = 3650;

/** On globalThis because a dev server can load this module more than once. */
const store = globalThis as { demoClockOffsetDays?: number | undefined };

const isProduction = (env: ClockEnv): boolean => env.NODE_ENV === "production";

const parseOffset = (raw: string | undefined): number => {
  const text = raw?.trim() ?? "";
  if (text === "") return 0;
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0 || days > MAX_OFFSET_DAYS) {
    throw new Error(
      `DEMO_CLOCK_OFFSET_DAYS must be a number of days from 0 to ${String(MAX_OFFSET_DAYS)}. Fix it in your local env file and restart.`,
    );
  }
  return days;
};

export const demoOffsetDays = (env: ClockEnv = process.env): number => {
  if (isProduction(env)) return 0;
  return store.demoClockOffsetDays ?? parseOffset(env.DEMO_CLOCK_OFFSET_DAYS);
};

/** A jump, until restart. Undefined goes back to the env value. */
export const setDemoOffsetDays = (days: number | undefined, env: ClockEnv = process.env): void => {
  if (isProduction(env)) {
    throw new Error("The demo clock only runs in development.");
  }
  store.demoClockOffsetDays = days;
};

/** The current time, as the app should see it. Pass it as `now` to anything that needs the time. */
export const appNow = (env: ClockEnv = process.env, real: Date = new Date()): Date =>
  new Date(real.getTime() + demoOffsetDays(env) * DAY_MS);

/** What Postgres adds to its own timestamps, in seconds. */
export const demoOffsetSeconds = (env: ClockEnv = process.env): number =>
  Math.round(demoOffsetDays(env) * SECONDS_PER_DAY);
