import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appEnv } from "./e2e/env";

// The E2E's promise that it can't reach real services rests on this file, so it gets its own test.

const FAKE = "http://127.0.0.1:3101";
const realFetch = globalThis.fetch;
const seen = vi.fn<(url: string, headers: Headers) => void>();

beforeAll(() => {
  process.env.E2E_FAKE_URL = FAKE;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    seen(String(input instanceof Request ? input.url : input), new Headers(init?.headers));
    return Promise.resolve(new Response("{}"));
  };
  const file = join(import.meta.dirname, "e2e", "fake-network.cjs");
  createRequire(import.meta.url)(file);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.E2E_FAKE_URL;
});

describe("the E2E's network guard", () => {
  it.each([
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    "https://oauth2.googleapis.com/token",
    "https://api.anthropic.com/v1/chat/completions",
    "http://127.0.0.1:11434/v1/chat/completions",
    "http://127.0.0.1:4000/v1/chat/completions",
    "http://localhost:5678/webhook/x",
  ])("sends %s to the fake services, never to the real one", async (url) => {
    seen.mockClear();
    await fetch(url, { method: "POST", body: "{}" });
    const [target, headers] = seen.mock.calls[0] ?? [];
    expect(target).toBe(`${FAKE}/__fake`);
    expect(headers?.get("x-e2e-original-url")).toBe(url);
  });

  it.each([
    "https://api-m.paypal.com/v2/invoicing/invoices",
    "https://api.openai.com/v1/chat/completions",
    "https://api.telegram.org/botX/sendMessage",
    "https://example.com/",
  ])("refuses %s outright, without any call going out", async (url) => {
    seen.mockClear();
    await expect(fetch(url)).rejects.toThrow(/E2E: refused/);
    expect(seen).not.toHaveBeenCalled();
  });

  it("leaves the server's own local calls alone", async () => {
    seen.mockClear();
    await fetch("http://127.0.0.1:3100/api/x");
    expect(seen.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/x");
  });

  it("the server gets fake values only, and the sender may mail only the seeded client", () => {
    const env = appEnv();
    expect(env.E2E_FAKE_URL).toBe(FAKE);
    expect(env.DATABASE_URL).toContain(":5433/e2e");
    expect(env.DEV_EMAIL_ALLOWLIST).toBe("hudson-street-bakery@example.test");
    expect(env.PAYPAL_CLIENT_SECRET).toMatch(/^e2e-/);
    expect(env.GMAIL_CLIENT_SECRET).toMatch(/^e2e-/);
  });
});
