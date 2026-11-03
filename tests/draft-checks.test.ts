import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { routeTask } from "@/lib/ai-router";
import type { AiConnection } from "@/lib/ai-settings";
import { amountsIn, checkedDraftSchema, draftProblems } from "@/lib/draft-checks";
import type { DraftRequest } from "@/lib/draft-facts";
import { draftMessages } from "@/lib/draft-prompts";
import { draftTemplate } from "@/lib/draft-templates";
import { maintenanceFacts, PAY_LINK, reminderFacts } from "./fixtures/draft-facts";

// Checks on drafted emails beyond their JSON shape, alone and through the router (mock model).

const tier1: DraftRequest = { kind: "tier1", facts: reminderFacts({ daysOverdue: 3 }) };
const body = (text: string) => ({ subject: "Invoice FPR-000042", body: text });

describe("amountsIn", () => {
  it.each([
    ["USD 1,500.00", ["1500"]],
    ["$1,500", ["1500"]],
    ["1500.50 EUR and £20", ["1500.5", "20"]],
    ["invoice FPR-000042, INV2 2026, 14 days", []],
    ["Invoice FPR-000042\nUSD 1,500.00", ["1500"]],
    [`pay at ${PAY_LINK}`, []],
  ])("%s", (text, expected) => {
    expect(amountsIn(text)).toEqual(expected);
  });
});

describe("draftProblems", () => {
  it("accepts a draft with the pay link and the facts' amount", () => {
    expect(draftProblems(body(`Hi Sam, $1,500 is due.\n${PAY_LINK}.`), tier1)).toEqual([]);
  });

  it("refuses a draft without the pay link", () => {
    expect(draftProblems(body("Hi Sam, please pay."), tier1)).toContain(
      "the body doesn't include the pay link",
    );
  });

  it("refuses a draft with any other link", () => {
    const text = `Pay here ${PAY_LINK} or at https://evil.example/pay`;
    expect(draftProblems(body(text), tier1)).toContain("it has a link other than the pay link");
  });

  it("refuses an amount that isn't in the facts", () => {
    const text = `USD 1,500.00 plus a USD 50.00 fee.\n${PAY_LINK}`;
    expect(draftProblems(body(text), tier1)).toContain(
      "it mentions an amount that isn't in the facts",
    );
  });

  it("allows an amount quoted from the citation", () => {
    const facts = reminderFacts({
      citation: { kind: "contract", text: "A late fee of USD 50.00 applies." },
    });
    const text = `USD 1,500.00. A late fee of USD 50.00 applies.\n${PAY_LINK}`;
    expect(draftProblems(body(text), { kind: "tier3", facts })).toEqual([]);
  });

  it("refuses a subject with a line break", () => {
    const draft = { subject: "Hi\nBcc: x@example.test", body: PAY_LINK };
    expect(draftProblems(draft, tier1)).toContain("the subject has a line break");
  });

  it("maintenance: no link at all, and only the estimate", () => {
    const request: DraftRequest = { kind: "maintenance", facts: maintenanceFacts() };
    expect(draftProblems(body("Estimate USD 200.00."), request)).toEqual([]);
    expect(draftProblems(body("See https://x.example"), request)).toContain(
      "it has a link, but a maintenance heads-up has none",
    );
    expect(draftProblems(body("About USD 250.00."), request)).toHaveLength(1);
  });
});

describe("drafting through the router (mock model)", () => {
  const server = setupServer();
  const URL = "http://127.0.0.1:11434/v1/chat/completions";
  const local: AiConnection = {
    order: 1,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    isLocal: true,
    apiKey: null,
  };
  const answers = (replies: object[]) => {
    let call = 0;
    server.use(
      http.post(URL, () => {
        const reply = replies[Math.min(call++, replies.length - 1)];
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
      }),
    );
  };
  const route = () =>
    routeTask([local], {
      messages: draftMessages(tier1),
      schema: checkedDraftSchema(tier1),
      template: draftTemplate(tier1),
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

  it("keeps a good draft from the model", async () => {
    answers([body(`Hi Sam, USD 1,500.00 was due.\n${PAY_LINK}`)]);
    const result = await route();
    expect(result.ok && result.via).toBe("model");
  });

  it("retries a draft that drops the pay link, then uses the template", async () => {
    answers([body("Hi Sam, please pay soon.")]);
    const result = await route();
    expect(result.ok && result.via).toBe("template");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["invalid", "invalid"]);
    expect(result.ok && result.output.body).toContain(PAY_LINK);
  });

  it("accepts the retry when it fixes the draft", async () => {
    answers([body("No link."), body(`Fixed.\n${PAY_LINK}`)]);
    const result = await route();
    expect(result.ok && result.via).toBe("model");
  });
});
