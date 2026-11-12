import { describe, expect, it } from "vitest";
import { authProblem, currentUserId, DEMO_USER_ID } from "@/lib/auth";
import { baseUrlProblem } from "@/lib/ai-url";
import {
  DEMO_COOKIE_MAX_AGE,
  demoCookieValid,
  gateDecision,
  isOpenPath,
  safeNext,
  signDemoCookie,
  type DemoEnv,
} from "@/lib/demo-gate";
import { createLoginLimiter, demoLoginHandler } from "@/lib/demo-login-handler";

// The public demo's password gate: the decision per request, the cookie, the login route with its
// guess limit, the production start-up rule and the AI address allowlist. No network.

const PASSWORD = "demo-password-0123456789";
const SECRET = "c".repeat(64);
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const DEMO: DemoEnv = {
  NODE_ENV: "production",
  DEMO_MODE: "true",
  DEMO_PASSWORD: PASSWORD,
  DEMO_COOKIE_SECRET: SECRET,
};

const decide = (pathname: string, cookie?: string, env: DemoEnv = DEMO, search = "") =>
  gateDecision({ pathname, search, cookie, env, nowMs: NOW });

describe("the gate on each request", () => {
  it("answers 401 to an API route without the cookie", () => {
    expect(decide("/api/clients").action).toBe("unauthorized");
    expect(decide("/api/settings/ai", "nonsense").action).toBe("unauthorized");
  });

  it("sends a page without the cookie to the login page, remembering where it was going", () => {
    expect(decide("/outbox", undefined, DEMO, "?tab=sent")).toEqual({
      action: "login",
      next: "/outbox?tab=sent",
    });
  });

  it("lets a request with a valid cookie through", () => {
    const cookie = signDemoCookie(SECRET, NOW);
    expect(decide("/api/clients", cookie).action).toBe("allow");
    expect(decide("/outbox", cookie).action).toBe("allow");
  });

  it("refuses a tampered, expired, foreign or malformed cookie", () => {
    const good = signDemoCookie(SECRET, NOW);
    const [expiry = "", signature = ""] = good.split(".");
    const bad = [
      `${String(Number(expiry) + 99999)}.${signature}`, // longer expiry, same signature
      `${expiry}.${"0".repeat(64)}`,
      `${expiry}.${signature.slice(0, -1)}0`,
      signDemoCookie("d".repeat(64), NOW), // signed with another secret
      expiry,
      `${good}.extra`,
      "",
      "abc.def",
    ];
    for (const cookie of bad) {
      expect(demoCookieValid(cookie, SECRET, NOW), cookie).toBe(false);
      expect(decide("/api/clients", cookie).action, cookie).toBe("unauthorized");
    }
    const later = NOW + (DEMO_COOKIE_MAX_AGE + 1) * 1000;
    expect(demoCookieValid(good, SECRET, later)).toBe(false);
    expect(demoCookieValid(good, SECRET, NOW)).toBe(true);
  });

  it.each([
    "/welcome",
    "/welcome/",
    "/demo-login",
    "/api/demo-login",
    "/api/webhooks/paypal",
    "/sign/abc123",
    "/api/sign/abc123",
    "/api/internal/scheduler/run",
    "/api/integrations/gmail/callback",
    "/_next/static/chunks/app/page.js",
    "/_next/static/chunks/app/clients/%5Bid%5D/page.js",
    "/favicon.ico",
    "/getpaid-stamp.svg",
    "/fonts/ClashDisplay-Semibold.woff2",
  ])("lets %s through without a password", (path) => {
    expect(decide(path).action).toBe("allow");
  });

  it.each([
    "/",
    "/outbox",
    "/settings/ai",
    "/api/integrations/gmail",
    "/api/internal",
    "/api/webhooks",
    "/api/webhooksfoo",
    "/welcomes",
    "/sign",
    "/api/webhooks/%2e%2e/settings",
    "/api/webhooks/..%2fsettings",
    "/api/webhooks/..\\settings",
    "/fonts//..//outbox",
    "/api/demo-login/../clients",
  ])("keeps %s behind the password", (path) => {
    expect(isOpenPath(path)).toBe(false);
    expect(decide(path).action).not.toBe("allow");
  });

  it("does nothing outside the public demo", () => {
    expect(decide("/api/clients", undefined, { NODE_ENV: "development" }).action).toBe("allow");
    expect(decide("/outbox", undefined, { NODE_ENV: "production" }).action).toBe("allow");
    expect(decide("/outbox", undefined, { NODE_ENV: "test", DEMO_MODE: "true" }).action).toBe(
      "allow",
    );
  });
});

describe("where to go after signing in", () => {
  it.each([
    "//evil.com",
    "//evil.com/path",
    "https://evil.com",
    "http://evil.com/x",
    "javascript:alert(1)",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "evil.com",
    "",
    undefined,
    42,
  ])("sends %j to the home page", (next) => {
    expect(safeNext(next)).toBe("/");
  });

  it("keeps a path on this site", () => {
    expect(safeNext("/outbox")).toBe("/outbox");
    expect(safeNext("/projects/1?tab=a#b")).toBe("/projects/1?tab=a#b");
  });
});

describe("POST /api/demo-login", () => {
  const login = (handler: ReturnType<typeof demoLoginHandler>, body: unknown, ip = "203.0.113.7") =>
    handler.post(
      new Request("https://demo.example/api/demo-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.2` },
        // The username is "admin" (the default) unless a test gives its own.
        body: JSON.stringify(
          typeof body === "object" && body !== null && !("username" in body)
            ? { username: "admin", ...body }
            : body,
        ),
      }),
    );

  const build = (env: DemoEnv = DEMO) => {
    let now = NOW;
    const handler = demoLoginHandler({ env, now: () => now, limiter: createLoginLimiter() });
    return {
      handler,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it("sets a signed, HttpOnly, Secure cookie on the right password", async () => {
    const { handler } = build();
    const response = await login(handler, { password: PASSWORD, next: "/outbox" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "/outbox" });
    const header = response.headers.get("set-cookie") ?? "";
    for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) {
      expect(header).toContain(part);
    }
    const value = /^gp_demo=([^;]+)/.exec(header)?.[1];
    expect(demoCookieValid(value, SECRET, NOW)).toBe(true);
  });

  it("sends an off-site next to the home page, never off the site", async () => {
    for (const next of ["//evil.com", "https://evil.com", "/\\evil.com"]) {
      const response = await login(build().handler, { password: PASSWORD, next });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ next: "/" });
    }
  });

  it("refuses a wrong or missing username, even with the right password", async () => {
    for (const username of ["root", "Admin ", "", "admin2"]) {
      const response = await login(build().handler, { username, password: PASSWORD });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("uses DEMO_USERNAME when it's set, and accepts a short password with symbols", async () => {
    const custom = build({ ...DEMO, DEMO_USERNAME: "judge", DEMO_PASSWORD: "#123abc*" });
    expect((await login(custom.handler, { password: "#123abc*" })).status).toBe(401);
    const ok = await login(custom.handler, { username: " judge ", password: "#123abc*" });
    expect(ok.status).toBe(200);
  });

  it("refuses a wrong password without setting a cookie", async () => {
    const response = await login(build().handler, { password: "wrong" });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 429 from the 6th wrong password in 10 minutes, even for the right one", async () => {
    const { handler, advance } = build();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await login(handler, { password: `wrong-${String(attempt)}` })).status).toBe(401);
    }
    const sixth = await login(handler, { password: "wrong-6" });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(handler, { password: PASSWORD })).status).toBe(429);
    // Another address is not affected.
    expect((await login(handler, { password: PASSWORD }, "198.51.100.9")).status).toBe(200);
    advance(10 * 60 * 1000 + 1000);
    expect((await login(handler, { password: PASSWORD })).status).toBe(200);
  });

  it("does not count guesses that are spread over more than 10 minutes", async () => {
    const { handler, advance } = build();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await login(handler, { password: "wrong" })).status).toBe(401);
      advance(3 * 60 * 1000);
    }
  });

  it("is not there outside the public demo, or with weak demo settings", async () => {
    const dev = build({ NODE_ENV: "development", DEMO_MODE: "true", DEMO_PASSWORD: PASSWORD });
    expect((await login(dev.handler, { password: PASSWORD })).status).toBe(404);
    const weak = build({ ...DEMO, DEMO_PASSWORD: "short" });
    expect((await login(weak.handler, { password: "short" })).status).toBe(404);
  });

  it("needs a JSON body with a password", async () => {
    const { handler } = build();
    expect((await login(handler, {})).status).toBe(400);
    const form = await handler.post(
      new Request("https://demo.example/api/demo-login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `password=${PASSWORD}`,
      }),
    );
    expect(form.status).toBe(415);
  });
});

describe("production without the demo gate", () => {
  it("refuses to start when DEMO_MODE is unset or not true", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", DEMO_MODE: "false" },
      {
        NODE_ENV: "production",
        DEMO_MODE: "1",
        DEMO_PASSWORD: PASSWORD,
        DEMO_COOKIE_SECRET: SECRET,
      },
    ]) {
      expect(authProblem(env)).toContain("DEMO_MODE=true");
      expect(() => currentUserId(env)).toThrow("DEMO_MODE=true");
    }
  });

  it("refuses to start with a short demo password or cookie secret, and says which", () => {
    const shortPassword = { ...DEMO, DEMO_PASSWORD: "x".repeat(7) };
    expect(authProblem(shortPassword)).toContain("DEMO_PASSWORD must be at least 8");
    const shortSecret = { ...DEMO, DEMO_COOKIE_SECRET: "x".repeat(31) };
    expect(() => currentUserId(shortSecret)).toThrow("DEMO_COOKIE_SECRET must be at least 32");
    expect(authProblem({ ...DEMO, DEMO_PASSWORD: undefined })).toContain("DEMO_PASSWORD");
  });

  it("never puts a secret in the message", () => {
    const message = authProblem({ ...DEMO, DEMO_COOKIE_SECRET: "s3cret-but-short" }) ?? "";
    expect(message).not.toContain("s3cret-but-short");
  });

  it("acts as the seeded demo user once the gate is set up, ignoring DEV_USER_ID", () => {
    expect(authProblem(DEMO)).toBeUndefined();
    expect(currentUserId({ ...DEMO, DEV_USER_ID: "11111111-1111-4111-8111-111111111111" })).toBe(
      DEMO_USER_ID,
    );
  });

  it("leaves development alone", () => {
    expect(authProblem({ NODE_ENV: "development" })).toBeUndefined();
    expect(currentUserId({ NODE_ENV: "development", DEV_USER_ID: "abc" })).toBe("abc");
  });
});

describe("AI addresses on the public demo", () => {
  const demoProblem = (url: string, isLocal: boolean) => baseUrlProblem(url, isLocal, true);

  it.each([
    ["http://postgres:5432/v1", true],
    ["http://n8n:5678/v1", true],
    ["http://caddy:80/v1", true],
    ["http://web:3000/v1", true],
    ["http://host.docker.internal:3000/v1", true],
    ["http://127.0.0.1:5678/v1", true],
    ["http://ollama:5678/v1", true],
    ["http://litellm:5432/v1", true],
    ["https://ollama:11434/v1", true],
    ["https://evil.example.com/v1", false],
    ["https://api.anthropic.com.evil.example.com/v1", false],
    ["https://api.anthropic.com:8443/v1", false],
    ["https://user:pass@api.openai.com/v1", false],
  ])("refuses %s", (url, isLocal) => {
    expect(demoProblem(url, isLocal)).toBeDefined();
  });

  it.each([
    ["https://api.anthropic.com/v1", false],
    ["https://api.openai.com/v1", false],
    ["https://generativelanguage.googleapis.com/v1beta/openai", false],
    ["https://api.groq.com/openai/v1", false],
    ["https://openrouter.ai/api/v1", false],
    ["http://ollama:11434/v1", true],
    ["http://litellm:4000/v1", true],
  ])("allows %s", (url, isLocal) => {
    expect(demoProblem(url, isLocal)).toBeUndefined();
  });

  it("changes nothing outside the demo", () => {
    expect(baseUrlProblem("http://postgres:5432/v1", true)).toBeUndefined();
    expect(baseUrlProblem("http://127.0.0.1:11434/v1", true, false)).toBeUndefined();
  });
});
