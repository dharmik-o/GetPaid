import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { routeTask } from "@/lib/ai-router";
import { classificationSchema, type Classification } from "@/lib/ai-schemas";
import type { AiConnection } from "@/lib/ai-settings";

// The AI router with mock models (msw): local first, then the cloud fallback only if the user
// added one, then the fixed template. Invalid output is retried once, then the template.
// No real network calls.

const server = setupServer();

const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const CLOUD_URL = "https://api.anthropic.com/v1/chat/completions";
const CLOUD_KEY = "sk-ant-router-test-key";

const local: AiConnection = {
  order: 1,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2",
  isLocal: true,
  apiKey: null,
};
const cloud: AiConnection = {
  order: 2,
  provider: "claude",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-sonnet-5-5",
  isLocal: false,
  apiKey: CLOUD_KEY,
};

const PROMISE: Classification = {
  label: "promise",
  promisedDate: "2026-11-15",
  returnDate: null,
  summary: "Says they'll pay on the 15th.",
};
const TEMPLATE: Classification = {
  label: "unclear",
  promisedDate: null,
  returnDate: null,
  summary: "Couldn't sort this reply automatically. Please read it.",
};

const messages = [
  { role: "system" as const, content: "Sort the client's reply. Answer with JSON only." },
  { role: "user" as const, content: "<reply>I'll pay on the 15th.</reply>" },
];

const request = { messages, schema: classificationSchema, template: TEMPLATE };

type Seen = { url: string; authorization: string | null; body: Record<string, unknown> };

/** Answers each call with the next reply in the list; records what was sent. */
/** "network" fails the connection; a number is an HTTP status; other text is the answer. */
const model = (url: string, replies: (string | number)[], seen: Seen[] = []) =>
  http.post(url, async ({ request: sent }) => {
    seen.push({
      url,
      authorization: sent.headers.get("authorization"),
      body: (await sent.json()) as Record<string, unknown>,
    });
    const reply = replies.shift() ?? 500;
    if (reply === "network") return HttpResponse.error();
    if (typeof reply === "number") return new HttpResponse(null, { status: reply });
    return HttpResponse.json({ choices: [{ message: { role: "assistant", content: reply } }] });
  });

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("routeTask", () => {
  it("uses the local model when it answers with valid JSON", async () => {
    const seen: Seen[] = [];
    server.use(model(LOCAL_URL, [JSON.stringify(PROMISE)], seen));
    const result = await routeTask([local, cloud], request);
    expect(result).toMatchObject({ ok: true, via: "model", output: PROMISE, model: "llama3.2" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toMatchObject({ model: "llama3.2", messages, temperature: 0 });
    expect(seen[0]?.body).not.toHaveProperty("response_format");
    expect(seen[0]?.authorization).toBeNull();
  });

  it("accepts JSON wrapped in a code fence", async () => {
    server.use(model(LOCAL_URL, ["```json\n" + JSON.stringify(PROMISE) + "\n```"]));
    expect(await routeTask([local], request)).toMatchObject({ ok: true, output: PROMISE });
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    const seen: Seen[] = [];
    server.use(model(LOCAL_URL, ["Sure! The label is promise.", JSON.stringify(PROMISE)], seen));
    const result = await routeTask([local, cloud], request);
    expect(result).toMatchObject({ ok: true, via: "model", output: PROMISE });
    expect(seen).toHaveLength(2);
    const retryMessages = seen[1]?.body.messages as { content: string }[];
    expect(retryMessages.at(-1)?.content).toMatch(/only the JSON object/);
  });

  it("invalid JSON twice: the template, without trying the cloud model", async () => {
    const seen: Seen[] = [];
    server.use(model(LOCAL_URL, ["nope", '{"label":"paid"}'], seen), model(CLOUD_URL, [], seen));
    const result = await routeTask([local, cloud], request);
    expect(result).toMatchObject({ ok: true, via: "template", output: TEMPLATE });
    expect(seen.map((s) => s.url)).toEqual([LOCAL_URL, LOCAL_URL]);
    if (!result.ok) return;
    expect(result.attempts.map((a) => a.outcome)).toEqual(["invalid", "invalid"]);
  });

  it("invalid twice with no template: fails, and nothing is used", async () => {
    server.use(model(LOCAL_URL, ["nope", "still nope"]));
    const result = await routeTask([local], { messages, schema: classificationSchema });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("local model down: the cloud fallback, with its key", async () => {
    const seen: Seen[] = [];
    server.use(
      model(LOCAL_URL, ["network"], seen),
      model(CLOUD_URL, [JSON.stringify(PROMISE)], seen),
    );
    const result = await routeTask([cloud, local], request);
    expect(result).toMatchObject({ ok: true, via: "model", model: "claude-sonnet-5-5" });
    // Local first, whatever order the connections came in.
    expect(seen.map((s) => s.url)).toEqual([LOCAL_URL, CLOUD_URL]);
    expect(seen[1]?.authorization).toBe(`Bearer ${CLOUD_KEY}`);
  });

  it.each([500, 503, 429, 401, 404])(
    "treats HTTP %d as unavailable and moves on",
    async (status) => {
      server.use(model(LOCAL_URL, [status]), model(CLOUD_URL, [JSON.stringify(PROMISE)]));
      const result = await routeTask([local, cloud], request);
      expect(result).toMatchObject({ ok: true, via: "model", model: "claude-sonnet-5-5" });
      if (!result.ok) return;
      expect(result.attempts[0]).toMatchObject({
        outcome: "unavailable",
        detail: `HTTP ${String(status)}`,
      });
    },
  );

  it("every model down: the template, or unavailable when there's none", async () => {
    server.use(model(LOCAL_URL, ["network", "network"]), model(CLOUD_URL, [503, 503]));
    expect(await routeTask([local, cloud], request)).toMatchObject({ ok: true, via: "template" });
    expect(
      await routeTask([local, cloud], { messages, schema: classificationSchema }),
    ).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("no model saved: the template", async () => {
    expect(await routeTask([], request)).toMatchObject({ ok: true, via: "template" });
  });

  it("gives up on a model that's too slow", async () => {
    server.use(
      http.post(LOCAL_URL, async () => {
        await delay(500);
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(PROMISE) } }] });
      }),
    );
    const result = await routeTask([local], request, { timeoutMs: 50 });
    expect(result).toMatchObject({ ok: true, via: "template" });
    if (!result.ok) return;
    expect(result.attempts[0]).toMatchObject({ outcome: "unavailable", detail: "timed out" });
  });

  it("never follows a redirect, so a key can't be sent somewhere else", async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(CLOUD_URL, () =>
        HttpResponse.redirect("https://evil.example.test/v1/chat/completions", 307),
      ),
      model("https://evil.example.test/v1/chat/completions", [JSON.stringify(PROMISE)], seen),
    );
    const result = await routeTask([cloud], request);
    expect(result).toMatchObject({ ok: true, via: "template" });
    expect(seen).toHaveLength(0);
  });

  it("never calls a blocked address, even if one was saved before the rule", async () => {
    const metadata = { ...local, baseUrl: "http://169.254.169.254/v1" };
    const result = await routeTask([metadata], request);
    expect(result).toMatchObject({ ok: true, via: "template" });
    if (!result.ok) return;
    expect(result.attempts[0]?.detail).toMatch(/metadata/);
  });

  it("refuses a template that doesn't match the schema", async () => {
    await expect(
      routeTask([], { messages, schema: classificationSchema, template: { label: "x" } as never }),
    ).rejects.toThrow(/template/);
  });

  it("reports attempts without keys or message text", async () => {
    server.use(model(LOCAL_URL, ["network"]), model(CLOUD_URL, ["nope", "nope"]));
    const result = await routeTask([local, cloud], request);
    const text = JSON.stringify(result);
    expect(text).not.toContain(CLOUD_KEY);
    expect(text).not.toContain("15th.</reply>");
  });
});
