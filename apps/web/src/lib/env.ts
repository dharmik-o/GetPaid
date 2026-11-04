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

// The token n8n sends to the app's internal routes (the AI router). Checked when such a route
// is called, so the dashboard still starts without it.
const internalEnvSchema = z.object({
  INTERNAL_API_TOKEN: requiredText().min(
    32,
    "must be at least 32 characters (generate one with: openssl rand -hex 32)",
  ),
});

export type InternalEnv = z.output<typeof internalEnvSchema>;

export const INTERNAL_ENV_NAMES = Object.keys(internalEnvSchema.shape);

/** Checks the internal API token. The error names the problem but never prints the value. */
export const parseInternalEnv = (source: Record<string, string | undefined>): InternalEnv => {
  const result = internalEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")} ${issue.message}`,
    );
    throw new Error(
      [
        "The internal API settings are not valid:",
        ...lines,
        "Add INTERNAL_API_TOKEN to your local env file and the same value to the n8n credential (see .env.example), then restart.",
      ].join("\n"),
    );
  }
  return result.data;
};

/** The bot's public username for t.me links, or undefined when it's unset or not a username. */
export const telegramBotUsername = (
  source: Record<string, string | undefined> = process.env,
): string | undefined => {
  const name = source.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return name && /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : undefined;
};

export type GoogleOAuthEnv = { clientId: string; clientSecret: string };

/** The Google OAuth client, or undefined until both values are set. Never log the secret. */
export const googleOAuthEnv = (
  source: Record<string, string | undefined> = process.env,
): GoogleOAuthEnv | undefined => {
  const clientId = source.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = source.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

/** Where real Gmail sends may go in dev (security rule 8). Empty means nothing sends. */
export const devEmailAllowlist = (
  source: Record<string, string | undefined> = process.env,
): ReadonlySet<string> =>
  new Set(
    (source.DEV_EMAIL_ALLOWLIST ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  );

/** The Outbox's public address for Telegram messages, or undefined when it isn't set. */
export const outboxPublicUrl = (
  source: Record<string, string | undefined> = process.env,
): string | undefined => {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(source.APP_PUBLIC_URL?.trim());
  return parsed.success ? `${parsed.data.replace(/\/+$/, "")}/outbox` : undefined;
};

/** The internal API token, or undefined when it isn't set up (the route then answers 503). */
export const internalApiToken = (source: Record<string, string | undefined> = process.env) => {
  try {
    return parseInternalEnv(source).INTERNAL_API_TOKEN;
  } catch {
    return undefined;
  }
};
