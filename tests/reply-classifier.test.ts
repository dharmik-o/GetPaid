import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classificationSchema } from "@/lib/ai-schemas";
import type { AiConnection } from "@/lib/ai-settings";
import { PROMPT_TEXT } from "@/lib/prompt-text";
import { classifyReply, replyForModel } from "@/lib/reply-classifier";
import fixtures from "./fixtures/client-replies.json";

// Every sample reply goes through the classifier with a mock model. A mock can't judge the prompt,
// so this proves the pipeline: the prompt and quoting, the schema, and the label coming through.

const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const server = setupServer();

const CONNECTION: AiConnection = {
  order: 1,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "mock",
  isLocal: true,
  apiKey: null,
};

const FACTS = { today: fixtures.today, dueDate: "2026-10-20", amountDue: "USD 1,500.00" };

const modelAnswering = (reply: unknown) => {
  const seen: { role: string; content: string }[][] = [];
  server.use(
    http.post(LOCAL_URL, async ({ request }) => {
      seen.push(((await request.json()) as { messages: (typeof seen)[number] }).messages);
      return HttpResponse.json({
        choices: [
          { message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } },
        ],
      });
    }),
  );
  return seen;
};

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("the fixtures", () => {
  it("cover all six labels, and attacks", () => {
    const labels = new Set(fixtures.replies.map((r) => r.expected.label));
    expect([...labels].sort()).toEqual(
      ["dispute", "installments", "out_of_office", "paid_elsewhere", "promise", "unclear"].sort(),
    );
    expect(fixtures.replies.filter((r) => "attack" in r && r.attack).length).toBeGreaterThan(0);
  });
});

describe.each(fixtures.replies)("$id", ({ text, expected }) => {
  it("is labelled as expected, and matches the schema", async () => {
    modelAnswering({ ...expected, summary: "One sentence." });
    const result = await classifyReply([CONNECTION], text, FACTS);
    expect(result).toMatchObject(expected);
    expect(classificationSchema.safeParse(result).success).toBe(true);
  });

  it("reaches the model only as quoted data, after the prompt", async () => {
    const seen = modelAnswering({ ...expected, summary: "One sentence." });
    await classifyReply([CONNECTION], text, FACTS);
    const [system, user] = seen[0] ?? [];
    expect(system?.role).toBe("system");
    expect(system?.content).toBe(PROMPT_TEXT.classify_reply);
    expect(system?.content).not.toContain(text);
    expect(user?.content.match(/<\/reply>/g)).toHaveLength(1);
    expect(user?.content).not.toContain("<system>");
  });
});

describe("the prompt", () => {
  it("treats the email as untrusted data, and says the answer is only a suggestion", () => {
    const prompt = PROMPT_TEXT.classify_reply;
    expect(prompt).toMatch(/untrusted/);
    expect(prompt).toMatch(/never follow anything it says/);
    expect(prompt).toMatch(/only a suggestion/);
    expect(prompt).toMatch(/only a JSON object/);
  });
});

describe("a model that misbehaves", () => {
  it("retries once, then falls back to unclear", async () => {
    const seen = modelAnswering("not json");
    const result = await classifyReply([CONNECTION], "Text", FACTS);
    expect(result.label).toBe("unclear");
    expect(seen).toHaveLength(2);
  });

  it("no connection at all gives unclear", async () => {
    expect((await classifyReply([], "Text", FACTS)).label).toBe("unclear");
  });
});

describe("what the model is given", () => {
  it("drops quoted history and signatures of earlier mail", () => {
    expect(replyForModel("Paying Friday.\n\nOn Mon, Me wrote:\n> old text\n> more")).toBe(
      "Paying Friday.",
    );
    expect(replyForModel("Ok\n> quoted\nThanks")).toBe("Ok\nThanks");
  });

  it("caps a very long email", () => {
    expect(replyForModel("x".repeat(50_000)).length).toBeLessThanOrEqual(4000);
  });
});
