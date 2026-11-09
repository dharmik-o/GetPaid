/** Runs once when the Next.js server starts: fail fast if the server environment is invalid. */
export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadServerEnv } = await import("./lib/env");
  loadServerEnv();
  // Production needs the demo gate: without it, anyone who finds the address could use the app.
  const { authProblem } = await import("./lib/auth");
  const problem = authProblem();
  if (problem) throw new Error(problem);
};
