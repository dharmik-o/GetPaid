// `npm run env:check`: validates the server env the same way the dashboard does at startup,
// and the PayPal sandbox settings the invoice flow needs. Prints only names and problems, never values.
import {
  INTERNAL_ENV_NAMES,
  PAYPAL_ENV_NAMES,
  parseInternalEnv,
  parsePaypalEnv,
  parseServerEnv,
  SERVER_ENV_NAMES,
} from "../apps/web/src/lib/env";
import { DEFAULT_AI_ENV_NAMES, readDefaultAi } from "../apps/web/src/lib/ai-default";

const checks: [string, () => unknown, string[]][] = [
  ["Server environment", () => parseServerEnv(process.env), SERVER_ENV_NAMES],
  ["PayPal sandbox", () => parsePaypalEnv(process.env), PAYPAL_ENV_NAMES],
  ["Internal API (n8n to app)", () => parseInternalEnv(process.env), INTERNAL_ENV_NAMES],
];

const builtInAi = () => {
  const result = readDefaultAi(process.env);
  if (!result.ok && result.problem !== null)
    throw new Error(`Built-in AI model: ${result.problem}`);
};
checks.push(["Built-in AI model (optional)", builtInAi, [...DEFAULT_AI_ENV_NAMES]]);

for (const [label, check, names] of checks) {
  try {
    check();
    process.stdout.write(`${label} OK (${names.join(", ")})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
