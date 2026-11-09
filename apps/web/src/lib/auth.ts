import { demoSettingsProblem, isDemoMode, type DemoEnv } from "./demo-gate";

// Who the signed-in freelancer is. Real sign-in (Supabase Auth) isn't built yet, so in
// development every request acts as one local user. The dev server listens on 127.0.0.1 only.
// The public demo (production with DEMO_MODE=true) acts as the same seeded user, behind the
// password gate in proxy.ts.

/** The fake demo freelancer created by `npm run db:seed`. */
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

type AuthEnv = DemoEnv & Partial<Record<"DEV_USER_ID", string>>;

/** Why production can't run (no sign-in, or a weak demo gate), or undefined when it can. */
export const authProblem = (env: AuthEnv = process.env): string | undefined => {
  if (env.NODE_ENV !== "production") return undefined;
  if (!isDemoMode(env)) {
    return "Sign-in isn't set up yet, so the dashboard can't run in production. For the public demo, set DEMO_MODE=true with DEMO_PASSWORD and DEMO_COOKIE_SECRET (see docs/DEPLOY.md). Otherwise run it with `npm run dev`.";
  }
  const weak = demoSettingsProblem(env);
  return weak
    ? `Demo mode is on, but ${weak} Fix it in the server's env file, then restart.`
    : undefined;
};

export const currentUserId = (env: AuthEnv = process.env): string => {
  const problem = authProblem(env);
  if (problem) throw new Error(problem);
  return env.NODE_ENV === "production" ? DEMO_USER_ID : env.DEV_USER_ID?.trim() || DEMO_USER_ID;
};
