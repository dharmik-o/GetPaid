import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as connectGmail } from "@/app/api/integrations/gmail/route";
import { GET as gmailCallback } from "@/app/api/integrations/gmail/callback/route";
import { POST as runReplies } from "@/app/api/internal/replies/run/route";
import { POST as runScheduler } from "@/app/api/internal/scheduler/run/route";
import { POST as runSender } from "@/app/api/internal/sender/run/route";

// The route files themselves, wired to their real dependencies. Handler tests inject those, so
// they can't catch a route that imports or calls something wrongly. No database or network: each
// of these answers before reaching either.

const SAVED = { ...process.env };

const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
  vi.stubEnv("INTERNAL_API_TOKEN", "i".repeat(64));
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(process.env.PATH).toBe(SAVED.PATH);
});

describe("Connect Gmail", () => {
  it("says what to set when the OAuth client isn't configured", async () => {
    const response = await connectGmail(post("/api/integrations/gmail"));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("GOOGLE_CLIENT_ID");
  });

  it("the callback refuses when there's no OAuth client, and never returns an error page", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/none");
    const response = await gmailCallback(
      new Request("http://127.0.0.1:3000/api/integrations/gmail/callback?state=x&code=y"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/settings/integrations?gmail=");
  });
});

describe.each([
  ["sender", runSender, "/api/internal/sender/run"],
  ["scheduler", runScheduler, "/api/internal/scheduler/run"],
  ["reply listener", runReplies, "/api/internal/replies/run"],
])("the %s route", (_name, route, url) => {
  it("refuses without n8n's token", async () => {
    expect((await route(post(url))).status).toBe(401);
  });

  it("refuses a wrong token", async () => {
    expect((await route(post(url, { authorization: `Bearer ${"x".repeat(64)}` }))).status).toBe(
      401,
    );
  });

  it("answers 503 until the token is set", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "");
    expect((await route(post(url))).status).toBe(503);
  });
});
