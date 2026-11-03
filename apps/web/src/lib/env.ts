import { z } from "zod";
import { decodeEncryptionKey, ENCRYPTION_KEY_HELP } from "./encryption-key";

const MISSING = "is missing";

const requiredText = () => z.string({ error: MISSING }).trim().min(1, MISSING);

const isPostgresUrl = (value: string): boolean => {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const serverEnvSchema = z.object({
  ENCRYPTION_KEY: requiredText().transform((value, ctx) => {
    try {
      return decodeEncryptionKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: ENCRYPTION_KEY_HELP });
      return z.NEVER;
    }
  }),
  DATABASE_URL: requiredText().refine(isPostgresUrl, {
    message: "must be a postgres:// or postgresql:// connection URL",
  }),
});

export type ServerEnv = z.output<typeof serverEnvSchema>;

/** Every variable the server checks at startup; each must be listed in .env.example. */
export const SERVER_ENV_NAMES = Object.keys(serverEnvSchema.shape);

const describeProblems = (error: z.ZodError): string => {
  const lines = error.issues.map((issue) => `  - ${issue.path.join(".")} ${issue.message}`);
  return [
    "The server environment is not valid:",
    ...lines,
    "Add or fix these in your local env file (see .env.example), then restart.",
  ].join("\n");
};

/** Checks the given variables. The error names each problem but never prints a value. */
export const parseServerEnv = (source: Record<string, string | undefined>): ServerEnv => {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw new Error(describeProblems(result.error));
  return result.data;
};

let cached: ServerEnv | undefined;

/** The checked server env from process.env, parsed once. Throws on the first call if invalid. */
export const loadServerEnv = (): ServerEnv => (cached ??= parseServerEnv(process.env));

// PayPal sandbox credentials. Checked when PayPal is first used (and by `npm run env:check`),
// so the dashboard still starts for work that doesn't touch PayPal.
const paypalEnvSchema = z.object({
  PAYPAL_CLIENT_ID: requiredText(),
  PAYPAL_CLIENT_SECRET: requiredText(),
  /** Needed only to verify webhooks; the webhook handler checks it itself. */
  PAYPAL_WEBHOOK_ID: z.string().trim().min(1).optional(),
});

export type PaypalEnv = z.output<typeof paypalEnvSchema>;

export const PAYPAL_ENV_NAMES = Object.keys(paypalEnvSchema.shape);

/** Checks the PayPal sandbox variables. The error names each problem but never prints a value. */
export const parsePaypalEnv = (source: Record<string, string | undefined>): PaypalEnv => {
  const result = paypalEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")} ${issue.message}`,
    );
    throw new Error(
      [
        "The PayPal sandbox settings are not valid:",
        ...lines,
        "Add your PayPal sandbox app's credentials to your local env file (see .env.example), then restart.",
      ].join("\n"),
    );
  }
  return result.data;
};

let cachedPaypal: PaypalEnv | undefined;

export const loadPaypalEnv = (): PaypalEnv => (cachedPaypal ??= parsePaypalEnv(process.env));
