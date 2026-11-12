import { z } from "zod";
import {
  DEMO_COOKIE,
  DEMO_COOKIE_MAX_AGE,
  demoSettingsProblem,
  demoUsername,
  isDemoMode,
  passwordMatches,
  safeNext,
  signDemoCookie,
  type DemoEnv,
} from "./demo-gate";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson } from "./http";
import { errorKind, logEvent } from "./log";

// Server-only: POST /api/demo-login { username, password, next }. Checks the shared demo username
// and password, with a limit on wrong guesses per IP, and sets the signed cookie proxy.ts looks for.

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 10_000;

type Entry = { failures: number; since: number; blockedUntil: number };

/** In memory: 5 wrong tries from one address in 10 minutes block it for 10 minutes. */
export const createLoginLimiter = () => {
  const entries = new Map<string, Entry>();

  const prune = (now: number): void => {
    if (entries.size <= MAX_TRACKED) return;
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= now && now - entry.since >= WINDOW_MS) entries.delete(key);
    }
    // Still too many (a flood of addresses): forget the oldest first.
    for (const key of entries.keys()) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(key);
    }
  };

  return {
    /** Seconds until this address may try again, or 0 when it may. */
    waitSeconds: (key: string, now: number): number => {
      const until = entries.get(key)?.blockedUntil ?? 0;
      return until > now ? Math.ceil((until - now) / 1000) : 0;
    },
    fail: (key: string, now: number): void => {
      const entry = entries.get(key);
      const fresh = !entry || now - entry.since >= WINDOW_MS;
      const next: Entry = fresh
        ? { failures: 1, since: now, blockedUntil: 0 }
        : { ...entry, failures: entry.failures + 1 };
      if (next.failures >= MAX_FAILURES) next.blockedUntil = now + WINDOW_MS;
      entries.set(key, next);
      prune(now);
    },
    reset: (key: string): void => {
      entries.delete(key);
    },
  };
};

const bodySchema = z.object({
  username: z.string().max(200).default(""),
  password: z.string().min(1).max(500),
  next: z.string().max(2000).optional(),
});

type Deps = {
  env?: DemoEnv;
  now?: () => number;
  limiter?: ReturnType<typeof createLoginLimiter>;
  /** Runs after a correct password: a new demo session starts the guided tour again. */
  onLogin?: () => Promise<void>;
};

/** Caddy sets X-Forwarded-For; the first value is the visitor. */
const clientKey = (request: Request): string =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

export const demoLoginHandler = ({
  env = process.env,
  now = Date.now,
  limiter = createLoginLimiter(),
  onLogin,
}: Deps = {}) => ({
  post: async (request: Request): Promise<Response> => {
    if (!isDemoMode(env) || demoSettingsProblem(env)) return notFound("This page");
    const key = clientKey(request);
    const wait = limiter.waitSeconds(key, now());
    if (wait > 0) {
      logEvent("demo_login.blocked", {});
      const blocked = jsonResponse(
        { error: "Too many wrong tries. Wait 10 minutes, then try again." },
        429,
      );
      blocked.headers.set("retry-after", String(wait));
      return blocked;
    }
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = bodySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));

    // Both are always checked, so the time taken doesn't say which one was wrong.
    const nameOk = passwordMatches(parsed.data.username.trim(), demoUsername(env));
    const passwordOk = passwordMatches(parsed.data.password, env.DEMO_PASSWORD ?? "");
    if (!nameOk || !passwordOk) {
      limiter.fail(key, now());
      logEvent("demo_login.failed", {});
      return jsonResponse(
        { error: "That username or password isn't right. Check them and try again." },
        401,
      );
    }
    limiter.reset(key);
    logEvent("demo_login.ok", {});
    try {
      await onLogin?.();
    } catch (error) {
      // The tour is a nicety: a failed reset must not lock the demo out.
      logEvent("demo_login.tour_reset_failed", { error: errorKind(error) });
    }
    const response = jsonResponse({ next: safeNext(parsed.data.next) });
    const cookie = signDemoCookie(env.DEMO_COOKIE_SECRET ?? "", now());
    response.headers.append(
      "set-cookie",
      `${DEMO_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(DEMO_COOKIE_MAX_AGE)}`,
    );
    return response;
  },
});
