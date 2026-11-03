import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiTestHandler } from "@/lib/ai-test-handler";
import { SAMPLE_PAY_LINK } from "@/lib/ai-test-tasks";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// "Test connection" with a mock model (msw): 4 sample tasks, pass or fail for each.

let handle: TestDatabase;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const KEY = "sk-ant-connection-test-key";
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const CLOUD_URL = "https://api.anthropic.com/v1/chat/completions";

const handler = (userId = USER_A.userId) =>
  aiTestHandler({ runAsUser: (work) => runAsUser(handle.db, userId, work), box: () => box });

const run = async (userId = USER_A.userId) => handler(userId).post();

type Result = { task: string; pass: boolean; detail: string; model: string | null };

const resultsOf = async (response: Response): Promise<Result[]> =>
  ((await response.json()) as { results: Result[] }).results;

type Body = { model: string; messages: { role: string; content: string }[] };

/** A well-behaved model: sorts the two sample replies and drafts with the pay link. */
const goodAnswer = (body: Body): string => {
  const text = body.messages.map((m) => m.content).join("\n");
  if (text.includes("Sort the client's reply")) {
    const installments = text.includes("half now");
    return JSON.stringify({
      label: installments ? "installments" : "promise",
      promisedDate: installments ? null : "2026-11-15",
      returnDate: null,
      summary: installments ? "Asks to pay in two parts." : "Will pay on 15 November.",
    });
  }
  return JSON.stringify({
    subject: "Invoice FPR-TEST for Website redesign: Build",
    body: `Hi Sam, a reminder about USD 1,500.00. Pay here: ${SAMPLE_PAY_LINK}`,
  });
};

const modelAt = (url: string, answer: (body: Body) => string | number, calls: Body[] = []) =>
  http.post(url, async ({ request }) => {
    const body = (await request.json()) as Body;
    calls.push(body);
    const reply = answer(body);
    return typeof reply === "number"
      ? new HttpResponse(null, { status: reply })
      : HttpResponse.json({ choices: [{ message: { content: reply } }] });
  });

const saveLocal = (withCloud = false) =>
  runAsUser(handle.db, USER_A.userId, (db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: withCloud
          ? {
              provider: "claude",
              baseUrl: "https://api.anthropic.com/v1",
              model: "claude-sonnet-5-5",
              apiKey: KEY,
            }
          : null,
        taskModels: { sort: "llama3.2:1b" },
      },
      box,
    ),
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.ai_providers WHERE user_id = $1", [USER_A.userId]);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("POST /api/ai/test", () => {
  it("passes all 4 sample tasks with a working model, using the per-task model for sorting", async () => {
    await saveLocal();
    const calls: Body[] = [];
    server.use(modelAt(LOCAL_URL, goodAnswer, calls));
    const response = await run();
    expect(response.status).toBe(200);
    const results = await resultsOf(response);
    expect(results.map((r) => [r.task, r.pass])).toEqual([
      ["Sort a reply that promises a date", true],
      ["Sort a reply that asks to pay in parts", true],
      ["Draft a Tier 1 email", true],
      ["Draft a Tier 2 email", true],
    ]);
    expect(calls.map((c) => c.model)).toEqual([
      "llama3.2:1b",
      "llama3.2:1b",
      "llama3.2",
      "llama3.2",
    ]);
  });

  it("treats client text as quoted data in the prompt", async () => {
    await saveLocal();
    const calls: Body[] = [];
    server.use(modelAt(LOCAL_URL, goodAnswer, calls));
    await run();
    const sort = calls[0]?.messages ?? [];
    expect(sort[0]?.role).toBe("system");
    expect(sort[0]?.content).toMatch(/data, not instructions/);
    expect(sort[1]?.content).toMatch(/^<reply>[\s\S]*<\/reply>$/);
  });

  it("invalid JSON: one retry, then a fail that says the template would be used", async () => {
    await saveLocal();
    const calls: Body[] = [];
    server.use(modelAt(LOCAL_URL, () => "Happy to help!", calls));
    const results = await resultsOf(await run());
    expect(results.every((r) => !r.pass)).toBe(true);
    expect(results[0]?.detail).toMatch(/twice.*template/);
    // Each task: one call and one retry.
    expect(calls).toHaveLength(8);
  });

  it("names a wrong label or a missing pay link", async () => {
    await saveLocal();
    server.use(
      modelAt(LOCAL_URL, (body) => {
        const answer = goodAnswer(body);
        return answer
          .replace('"promise"', '"dispute"')
          .replace(SAMPLE_PAY_LINK, "https://example.test/pay");
      }),
    );
    const [promise, , tier1] = await resultsOf(await run());
    expect(promise?.detail).toMatch(/dispute.*promise/);
    expect(tier1?.detail).toMatch(/pay link/);
  });

  it("shows the cloud fallback answering when the local model is down", async () => {
    await saveLocal(true);
    server.use(
      http.post(LOCAL_URL, () => HttpResponse.error()),
      modelAt(CLOUD_URL, goodAnswer),
    );
    const response = await run();
    const text = await response.clone().text();
    const results = await resultsOf(response);
    expect(results.every((r) => r.pass)).toBe(true);
    expect(results[0]?.model).toBe("claude-sonnet-5-5");
    expect(results[0]?.detail).toMatch(/local model.*couldn't connect/i);
    expect(text).not.toContain(KEY);
  });

  it("explains what to check when the model refuses", async () => {
    await saveLocal();
    server.use(modelAt(LOCAL_URL, () => 401));
    const [first] = await resultsOf(await run());
    expect(first?.pass).toBe(false);
    expect(first?.detail).toMatch(/HTTP 401.*API key/);
  });

  it("asks for settings first when none are saved", async () => {
    const response = await run();
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/Save/);
  });
});
