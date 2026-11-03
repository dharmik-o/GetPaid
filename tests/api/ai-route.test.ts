import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiRouteHandler } from "@/lib/ai-route-handler";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The n8n-facing AI router endpoint: real migrations and RLS (PGlite), models mocked by msw.

let handle: TestDatabase;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const TOKEN = "t".repeat(64);
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";

const handler = (token: string | undefined) =>
  aiRouteHandler({
    runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
    box: () => box,
    token: () => token,
  });

const CLASSIFICATION = {
  label: "out_of_office",
  promisedDate: null,
  returnDate: "2026-11-20",
  summary: "Away until the 20th.",
};
const TEMPLATE = { label: "unclear", promisedDate: null, returnDate: null, summary: "Read it." };

const body = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_A.userId,
  task: "sort",
  schema: "classification",
  messages: [
    { role: "system", content: "Sort the reply. JSON only." },
    { role: "user", content: "<reply>Out of office until 20 Nov.</reply>" },
  ],
  template: TEMPLATE,
  ...overrides,
});

const call = (payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  handler(TOKEN).post(
    new Request("http://127.0.0.1:3000/api/internal/ai/route", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(payload),
    }),
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  await runAsUser(handle.db, USER_A.userId, (db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: null,
      },
      box,
    ),
  );
  // User B's fixture model (the LiteLLM mock address) is down in these tests.
  server.use(
    http.post(
      "http://localhost:4000/chat/completions",
      () => new HttpResponse(null, { status: 503 }),
    ),
  );
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("POST /api/internal/ai/route", () => {
  it("refuses a missing or wrong token, without calling any model", async () => {
    expect((await call(body(), null)).status).toBe(401);
    expect((await call(body(), "Bearer wrong")).status).toBe(401);
    expect((await call(body(), TOKEN)).status).toBe(401);
  });

  it("answers 503 until INTERNAL_API_TOKEN is set up", async () => {
    const response = await handler(undefined).post(
      new Request("http://127.0.0.1:3000/api/internal/ai/route", { method: "POST" }),
    );
    expect(response.status).toBe(503);
  });

  it("routes the task to the user's own model and returns the checked output", async () => {
    server.use(
      http.post(LOCAL_URL, () =>
        HttpResponse.json({ choices: [{ message: { content: JSON.stringify(CLASSIFICATION) } }] }),
      ),
    );
    const response = await call(body());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      via: "model",
      model: "llama3.2",
      output: CLASSIFICATION,
    });
  });

  it("uses each user's own settings (RLS): user B's model, not user A's", async () => {
    let localCalls = 0;
    server.use(
      http.post(LOCAL_URL, () => {
        localCalls += 1;
        return HttpResponse.json({ choices: [{ message: { content: "{}" } }] });
      }),
    );
    const response = await call(body({ userId: USER_B.userId, task: "draft" }));
    expect(await response.json()).toMatchObject({ ok: true, via: "template" });
    expect(localCalls).toBe(0);
  });

  it("falls back to the template when the model keeps answering badly", async () => {
    server.use(
      http.post(LOCAL_URL, () => HttpResponse.json({ choices: [{ message: { content: "no" } }] })),
    );
    expect(await (await call(body())).json()).toMatchObject({
      ok: true,
      via: "template",
      output: TEMPLATE,
    });
  });

  it("refuses a template that doesn't match the schema, and unknown schemas or tasks", async () => {
    expect((await call(body({ template: { label: "paid" } }))).status).toBe(400);
    expect((await call(body({ schema: "anything" }))).status).toBe(400);
    expect((await call(body({ task: "pay" }))).status).toBe(400);
    expect((await call(body({ userId: "not-a-uuid" }))).status).toBe(400);
  });
});
