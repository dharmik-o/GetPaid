import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// The public demo (decision E7): production with DEMO_MODE=true. The seeded demo freelancer then
// runs behind one shared password, so strangers can't use the dashboard. Pure helpers; the
// request handling is in proxy.ts and demo-login-handler.ts. Server-only.

export const DEMO_COOKIE = "gp_demo";
export const DEMO_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const MIN_PASSWORD_CHARS = 16;
const MIN_SECRET_CHARS = 32;

export type DemoEnv = Partial<
  Record<"NODE_ENV" | "DEMO_MODE" | "DEMO_PASSWORD" | "DEMO_COOKIE_SECRET", string>
>;

export const isDemoMode = (env: DemoEnv = process.env): boolean =>
  env.NODE_ENV === "production" && env.DEMO_MODE === "true";

/** What is wrong with the demo password or cookie secret, or undefined when both are strong enough. */
export const demoSettingsProblem = (env: DemoEnv): string | undefined => {
  if ((env.DEMO_PASSWORD ?? "").length < MIN_PASSWORD_CHARS) {
    return `DEMO_PASSWORD must be at least ${String(MIN_PASSWORD_CHARS)} characters.`;
  }
  if ((env.DEMO_COOKIE_SECRET ?? "").length < MIN_SECRET_CHARS) {
    return `DEMO_COOKIE_SECRET must be at least ${String(MIN_SECRET_CHARS)} characters (generate one with: openssl rand -hex 32).`;
  }
  return undefined;
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time password check (both sides hashed, so lengths never leak). */
export const passwordMatches = (given: string, expected: string): boolean =>
  expected !== "" && timingSafeEqual(digest(given), digest(expected));

const mac = (expiry: string, secret: string): string =>
  createHmac("sha256", secret).update(expiry).digest("hex");

/** The cookie value: `<expiry in unix seconds>.<HMAC-SHA256(expiry, secret)>`. */
export const signDemoCookie = (secret: string, nowMs: number): string => {
  const expiry = String(Math.floor(nowMs / 1000) + DEMO_COOKIE_MAX_AGE);
  return `${expiry}.${mac(expiry, secret)}`;
};

/** True only for a cookie this server signed that has not expired. */
export const demoCookieValid = (
  value: string | undefined,
  secret: string,
  nowMs: number,
): boolean => {
  if (!value || !secret) return false;
  const parts = value.split(".");
  const [expiry, signature] = parts;
  if (parts.length !== 2 || !expiry || !signature) return false;
  if (!/^\d{1,12}$/.test(expiry) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Number(expiry) <= nowMs / 1000) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(mac(expiry, secret), "hex"));
};

/** Where to go after signing in: a path on this site, otherwise the home page. */
export const safeNext = (next: unknown): string => {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/";
  // Browsers read a backslash as a slash and drop tabs and line breaks, so "/\evil.com" or
  // "/<tab>/evil.com" would leave the site.
  for (let at = 0; at < next.length; at += 1) {
    const code = next.charCodeAt(at);
    if (code < 32 || code === 127 || next[at] === "\\") return "/";
  }
  return next;
};

const OPEN_EXACT = new Set([
  "/welcome",
  "/demo-login",
  "/api/demo-login",
  "/api/integrations/gmail/callback",
  "/getpaid-stamp.svg",
]);
const OPEN_PREFIXES = [
  "/api/webhooks/",
  "/sign/",
  "/api/sign/",
  "/api/internal/",
  "/_next/",
  "/fonts/",
  "/favicon",
];

/**
 * Paths that need no password. Each has its own check: PayPal's signature, the signing token,
 * the internal token, or the OAuth state. A path that hides a slash, a dot segment or a
 * backslash in an encoded form is never open.
 */
export const isOpenPath = (pathname: string): boolean => {
  if (/%2f|%5c|%2e|\\|\.\.|\/\//i.test(pathname)) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return OPEN_EXACT.has(path) || OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
};

export type GateDecision =
  { action: "allow" } | { action: "unauthorized" } | { action: "login"; next: string };

type GateRequest = {
  pathname: string;
  search: string;
  cookie: string | undefined;
  env: DemoEnv;
  nowMs: number;
};

/** What to do with a request: let it through, answer 401 (API) or send the visitor to the login page. */
export const gateDecision = ({
  pathname,
  search,
  cookie,
  env,
  nowMs,
}: GateRequest): GateDecision => {
  if (!isDemoMode(env) || isOpenPath(pathname)) return { action: "allow" };
  if (demoCookieValid(cookie, env.DEMO_COOKIE_SECRET ?? "", nowMs)) return { action: "allow" };
  if (pathname.startsWith("/api/")) return { action: "unauthorized" };
  return { action: "login", next: safeNext(`${pathname}${search}`) };
};
