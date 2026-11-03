// `npm run env:check`: validates the server env the same way the dashboard does at startup,
// and the PayPal sandbox settings the invoice flow needs. Prints only names and problems, never values.
import {
  PAYPAL_ENV_NAMES,
  parsePaypalEnv,
  parseServerEnv,
  SERVER_ENV_NAMES,
} from "../apps/web/src/lib/env";

const checks: [string, () => unknown, string[]][] = [
  ["Server environment", () => parseServerEnv(process.env), SERVER_ENV_NAMES],
  ["PayPal sandbox", () => parsePaypalEnv(process.env), PAYPAL_ENV_NAMES],
];

for (const [label, check, names] of checks) {
  try {
    check();
    process.stdout.write(`${label} OK (${names.join(", ")})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
