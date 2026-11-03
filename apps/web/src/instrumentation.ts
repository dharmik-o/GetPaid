/** Runs once when the Next.js server starts: fail fast if the server environment is invalid. */
export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadServerEnv } = await import("./lib/env");
  loadServerEnv();
};
