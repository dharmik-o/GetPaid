import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { routeTask } from "@/lib/ai-router";
import type { AiConnection } from "@/lib/ai-settings";
import { PAYPAL_CURRENCIES } from "@/lib/currencies";
import { checkedDraftSchema, draftProblems, moneyIn } from "@/lib/draft-checks";
import type { DraftRequest } from "@/lib/draft-facts";
import { draftMessages } from "@/lib/draft-prompts";
import { draftTemplate } from "@/lib/draft-templates";
import {
  APPROVAL_LINK,
  autoPayFacts,
  maintenanceFacts,
  PAY_LINK,
  reminderFacts,
} from "./fixtures/draft-facts";

// Checks on drafted emails beyond their JSON shape, alone and through the router (mock model).

const tier1: DraftRequest = { kind: "tier1", facts: reminderFacts({ daysOverdue: 3 }) };
const body = (text: string) => ({ subject: "Invoice FPR-000042", body: text });

describe("moneyIn", () => {
  it.each([
    ["USD 1,500.00", ["USD 1500"]],
    ["USD1,500", ["USD 1500"]],
    ["$1,500", ["$ 1500"]],
    ["1500.50 EUR and £20", ["EUR 1500.5", "£ 20"]],
    ["1,500€ and 20 $", ["€ 1500", "$ 20"]],
    ["US$500, CA$500 and USD$500", ["US$ 500", "CA$ 500", "USD$ 500"]],
    ["₩1,500", ["₩ 1500"]],
    ["kr 500, 500 kr, RM500 and 500 zł", ["kr 500", "kr 500", "RM 500", "zł 500"]],
    ["invoice FPR-000042, INV2 2026, 14 days", []],
    ["Invoice FPR-000042\nUSD 1,500.00", ["USD 1500"]],
    ["Due 15 Dec 2026 USD 1,500.00", ["USD 1500"]],
    ["Due 15 Dec 2026 $1,500", ["$ 1500"]],
    ["150 km, 20 krona, a RM", []],
    [`pay at ${PAY_LINK}`, []],
  ])("%s", (text, expected) => {
    expect(moneyIn(text).map(({ unit, amount }) => `${unit} ${amount}`)).toEqual(expected);
  });
});

describe("a currency must belong to the amount in the facts", () => {
  const WRONG = "it gives an amount in the wrong currency";
  const inCurrency = (amountDue: string): DraftRequest => ({
    kind: "tier1",
    facts: reminderFacts({ daysOverdue: 3, amountDue }),
  });
  const draftWith = (text: string) => body(`${text} is due.\n${PAY_LINK}`);

  it.each([
    ["USD 1,500.00", "$1,500.00"],
    ["USD 1,500.00", "US$1,500"],
    ["USD 1,500.00", "1,500 USD"],
    ["CAD 1,500.00", "$1,500.00"],
    ["CAD 1,500.00", "CA$1,500.00"],
    ["AUD 1,500.00", "A$1,500.00"],
    ["TWD 1,500", "NT$1,500"],
    ["BRL 1,500.00", "R$1,500.00"],
    ["EUR 1,500.00", "€1,500.00"],
    ["GBP 1,500.00", "£1,500.00"],
    ["JPY 1,500", "¥1,500"],
    ["CNY 1,500.00", "¥1,500.00"],
    ["SEK 1,500.00", "1,500 kr"],
    ["NOK 1,500.00", "kr 1,500"],
    ["PLN 1,500.00", "1,500 zł"],
    ["MYR 1,500.00", "RM1,500.00"],
    ["ILS 1,500.00", "₪1,500.00"],
    ["PHP 1,500.00", "₱1,500.00"],
    ["THB 1,500.00", "฿1,500.00"],
  ])("%s may be written %s", (amountDue, written) => {
    expect(draftProblems(draftWith(written), inCurrency(amountDue))).toEqual([]);
  });

  it.each([
    ["EUR 1,500.00", "$1,500.00"],
    ["EUR 1,500.00", "USD 1,500.00"],
    ["EUR 1,500.00", "1,500 $"],
    ["USD 1,500.00", "€1,500.00"],
    ["USD 1,500.00", "1,500€"],
    ["USD 1,500.00", "£1,500.00"],
    ["USD 1,500.00", "CA$1,500.00"],
    ["USD 1,500.00", "CAD 1,500.00"],
    ["USD 1,500.00", "₩1,500"],
    ["USD 1,500.00", "1,500 kr"],
    ["CAD 1,500.00", "US$1,500.00"],
    ["CAD 1,500.00", "USD$1,500"],
    ["GBP 1,500.00", "$1,500.00"],
    ["BRL 1,500.00", "$1,500.00"],
    ["CHF 1,500.00", "$1,500.00"],
    ["JPY 1,500", "$1,500"],
    ["PLN 1,500.00", "€1,500.00"],
  ])("%s may not be written %s", (amountDue, written) => {
    expect(draftProblems(draftWith(written), inCurrency(amountDue))).toEqual([
      WRONG + `: ${written}`,
    ]);
  });

  it("accepts how Intl writes every PayPal currency", () => {
    for (const { code } of PAYPAL_CURRENCIES) {
      for (const currencyDisplay of ["symbol", "narrowSymbol"] as const) {
        const written = new Intl.NumberFormat("en", {
          style: "currency",
          currency: code,
          currencyDisplay,
        })
          .formatToParts(1)
          .find((part) => part.type === "currency")?.value;
        expect([
          code,
          written,
          draftProblems(draftWith(`${written ?? ""}1,500`), inCurrency(`${code} 1,500`)),
        ]).toEqual([code, written, []]);
      }
    }
  });

  it("every PayPal currency has its own rule for $", () => {
    const usesDollar = PAYPAL_CURRENCIES.map(({ code }) => code).filter(
      (code) => draftProblems(draftWith("$1,500"), inCurrency(`${code} 1,500`)).length === 0,
    );
    expect(usesDollar).toEqual(["AUD", "CAD", "HKD", "MXN", "TWD", "NZD", "SGD", "USD"]);
  });

  it("a contract's own symbol and its code count as the same money", () => {
    const facts = reminderFacts({
      citation: { kind: "contract", text: "A late fee of $50.00 applies." },
    });
    const text = `USD 1,500.00. A late fee of $50.00 applies. That adds USD 50.00.\n${PAY_LINK}`;
    expect(draftProblems(body(text), { kind: "tier3", facts })).toEqual([]);
    const euros = `USD 1,500.00. A late fee of $50.00 applies. That adds EUR 50.00.\n${PAY_LINK}`;
    expect(draftProblems(body(euros), { kind: "tier3", facts })).toEqual([`${WRONG}: EUR 50.00`]);
  });

  it("a hand edit can't change the currency either", () => {
    const typed = { typedByFreelancer: true };
    expect(draftProblems(draftWith("$1,500.00"), inCurrency("EUR 1,500.00"), [], typed)).toEqual([
      `${WRONG}: $1,500.00`,
    ]);
  });

  it("a wrong amount is still reported as one", () => {
    expect(draftProblems(draftWith("€1,600.00"), inCurrency("EUR 1,500.00"))).toEqual([
      "it mentions an amount that isn't in the facts",
    ]);
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

describe("the auto-pay approval email", () => {
  const request: DraftRequest = { kind: "auto_pay_approval", facts: autoPayFacts() };

  it("accepts the approval link as its only link", () => {
    const text = `USD 200.00 every month from 7 Dec 2026. Approve here:\n${APPROVAL_LINK}`;
    expect(draftProblems(body(text), request)).toEqual([]);
  });

  it("refuses a draft without the approval link", () => {
    expect(draftProblems(body("Please approve auto-pay."), request)).toContain(
      "the body doesn't include the approval link",
    );
  });

  it("refuses any other link, even a pay link", () => {
    const text = `${APPROVAL_LINK}\nOr here: ${PAY_LINK}`;
    expect(draftProblems(body(text), request)).toContain(
      "it has a link other than the approval link",
    );
  });

  it("refuses an amount or a date that isn't in the facts", () => {
    expect(draftProblems(body(`USD 250.00.\n${APPROVAL_LINK}`), request)).toContain(
      "it mentions an amount that isn't in the facts",
    );
    expect(draftProblems(body(`From 8 Dec 2026.\n${APPROVAL_LINK}`), request)).toContain(
      "it mentions a date that isn't in the facts: 8 Dec 2026",
    );
  });

  it("its fixed template passes, and states the terms before asking", () => {
    const draft = draftTemplate(request);
    expect(draftProblems(draft, request)).toEqual([]);
    expect(draft.body).toContain("USD 200.00");
    expect(draft.body).toContain("every month");
    expect(draft.body).toContain("7 Dec 2026");
    expect(draft.body).toContain(APPROVAL_LINK);
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
