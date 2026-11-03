// Who the signed-in freelancer is. Real sign-in (Supabase Auth) isn't built yet, so in
// development every request acts as one local user. The dev server listens on 127.0.0.1 only.

/** The fake demo freelancer created by `npm run db:seed`. */
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

type AuthEnv = Partial<Record<"NODE_ENV" | "DEV_USER_ID", string>>;

export const currentUserId = (env: AuthEnv = process.env): string => {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Sign-in isn't set up yet, so the dashboard can't run in production. Run it with `npm run dev` (see docs/NEEDS_YOU.md).",
    );
  }
  return env.DEV_USER_ID?.trim() || DEMO_USER_ID;
};
