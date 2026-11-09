// The public demo (decision E7): production with DEMO_MODE=true. D3 adds the password gate here.

type DemoEnv = Partial<Record<"NODE_ENV" | "DEMO_MODE", string>>;

export const isDemoMode = (env: DemoEnv = process.env): boolean =>
  env.NODE_ENV === "production" && env.DEMO_MODE === "true";
