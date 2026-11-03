// `npm run env:check`: validates the server env the same way the dashboard does at startup.
// Prints only variable names and problems, never values.
import { parseServerEnv, SERVER_ENV_NAMES } from "../apps/web/src/lib/env";

try {
  parseServerEnv(process.env);
  process.stdout.write(`Server environment OK (${SERVER_ENV_NAMES.join(", ")})\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
