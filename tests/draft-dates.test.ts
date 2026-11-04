import { describe, expect, it } from "vitest";
import { checkedDraftSchema, draftProblems } from "@/lib/draft-checks";
import { unknownDates } from "@/lib/draft-dates";
import type { DraftRequest } from "@/lib/draft-facts";
import { draftTemplate } from "@/lib/draft-templates";
import { maintenanceFacts, PAY_LINK, reminderFacts } from "./fixtures/draft-facts";

// Every date in a draft must be one the facts hold. The same date in another format is fine.

const DUE = "15 May 2027"; // A Saturday.
const unknown = (text: string, facts: string[] = [DUE]) => unknownDates(text, { facts });

describe("the same date in another format passes", () => {
  it.each([
    "15 May 2027",
    "May 15, 2027",
    "May 15 2027",
    "May 15th, 2027",
    "15th May 2027",
    "15th of May 2027",
    "15th of May, 2027",
    "the 15th of May",
    "the fifteenth of May",
    "May the 15th",
    "15-May-2027",
    "15 MAY 2027",
    "2027-05-15",
    "2027/05/15",
    "2027-05-15T10:00:00Z",
    "15/05/2027",
    "05/15/2027",
    "15/05/27",
    "5/15/27",
    "15.05.2027",
    "15-05-2027",
    "Sat 15 May 2027",
    "Saturday, May 15, 2027",
    "15 May",
    "May 15",
    "May 15th",
    "15/05",
    "May 2027",
    "May of 2027",
    "by May",
    "in May",
    "on the 15th",
    "by the 15th.",
    "by Saturday",
  ])("%s", (text) => {
    expect(unknown(`Please note ${text} for this.`)).toEqual([]);
  });
});

describe("any other date is found and refused", () => {
  it.each([
    ["16 May 2027"],
    ["May 16, 2027"],
    ["May 16th, 2027"],
    ["16th of May 2027"],
    ["the sixteenth of May"],
    ["15 June 2027"],
    ["June 15, 2027"],
    ["15 May 2028"],
    ["May 15, 2028"],
    ["2027-05-16"],
    ["2027/06/15"],
    ["16/05/2027"],
    ["05/16/2027"],
    ["16.05.2027"],
    ["16-05-2027"],
    ["15/05/28"],
    ["16 May"],
    ["May 16"],
    ["Jun 15"],
    ["16/05"],
    ["June 2027"],
    ["May 2028"],
    ["in June"],
    ["by June"],
    ["end of June"],
    ["on the 16th"],
    ["by the 20th."],
    ["31 Feb 2027"],
    // The right date with the wrong weekday isn't the same date.
    ["Friday 15 May 2027"],
    ["Friday, May 15"],
    ["by Monday"],
    ["on Friday"],
  ])("%s", (text) => {
    expect(unknown(`Please note ${text} for this.`)).toHaveLength(1);
  });

  it.each([
    ["today"],
    ["tomorrow"],
    ["tonight"],
    ["yesterday"],
    ["next week"],
    ["next month"],
    ["next year"],
    ["next Friday"],
    ["this Friday"],
    ["last Monday"],
    ["this week"],
    ["end of the month"],
    ["end of day"],
    ["end of the week"],
    ["in 3 days"],
    ["in two weeks"],
    ["within 7 days"],
    ["within a week"],
    ["5 days from now"],
    ["two weeks from now"],
    ["3 days ago"],
  ])("a relative date, which the facts can't hold: %s", (text) => {
    expect(unknown(`Please pay ${text} if you can.`)).toHaveLength(1);
  });

  it("names each one found", () => {
    expect(unknown("Due 16 May 2027, or by 20 June.")).toEqual(["16 May 2027", "20 June"]);
  });

  it("reports the real date, however it's written, once", () => {
    expect(unknown("On 2027-05-20.")).toEqual(["2027-05-20"]);
  });
});

describe("numbers and words that aren't dates are left alone", () => {
  it.each([
    "You may pay it here.",
    "May I ask you to pay?",
    "We may 2 of them.",
    "This is my 2nd reminder.",
    "This is the 3rd reminder about it.",
    "It's the 1st installment.",
    "Support is 24/7.",
    "Invoice FPR-000042 is open.",
    "INV2-TEST-AAAA-BBBB",
    "It's USD 1,500.00.",
    "USD 15.05 is left.",
    "It is 14 days overdue.",
    "Payment terms are Net 14.",
    "That's v1.2.3 of the site.",
    "It's 100% done.",
    "We'll march on.",
    "A second reminder.",
    "It's due soon.",
    "Thanks, and have a good day.",
    "Installment 2 of 3.",
    "Call 555-123-4567.",
    `Pay at ${PAY_LINK}`,
    "See https://example.test/2027-06-01/report",
  ])("%s", (text) => {
    expect(unknown(text)).toEqual([]);
  });
});

describe("what counts as in the facts", () => {
  it("an ambiguous date passes if either reading is in the facts", () => {
    expect(unknown("On 05/06/2027.", ["5 Jun 2027"])).toEqual([]);
    expect(unknown("On 05/06/2027.", ["6 May 2027"])).toEqual([]);
    expect(unknown("On 05/06/2027.", ["7 May 2027"])).toHaveLength(1);
  });

  it("reads every fact", () => {
    expect(unknown("By 18 Nov 2026 and 15 May 2027.", ["Due by 18 Nov 2026", DUE])).toEqual([]);
  });

  it("a date in a name the draft quotes isn't a new date", () => {
    const quoted = ["March 15 launch"];
    expect(unknownDates("About your March 15 launch.", { facts: [DUE], quoted })).toEqual([]);
    expect(unknownDates("About March 16.", { facts: [DUE], quoted })).toEqual(["March 16"]);
  });

  it("a span of days passes only as the agreed terms", () => {
    expect(unknown("Pay within 14 days.", ["Net 14"])).toEqual([]);
    expect(unknown("Pay within 7 days.", ["Net 14"])).toHaveLength(1);
  });

  it("alsoAllowed adds what the freelancer named", () => {
    const facts = [DUE];
    expect(unknownDates("By the 20th.", { facts, alsoAllowed: ["mention the 20th"] })).toEqual([]);
    expect(unknownDates("By next Friday.", { facts, alsoAllowed: ["say next Friday"] })).toEqual(
      [],
    );
    expect(unknownDates("By the 21st.", { facts, alsoAllowed: ["mention the 20th"] })).toHaveLength(
      1,
    );
  });
});

describe("the draft checks", () => {
  const maintenance: DraftRequest = { kind: "maintenance", facts: maintenanceFacts() };
  const reminder: DraftRequest = {
    kind: "tier1",
    facts: reminderFacts({ dueDate: "31 Oct 2026" }),
  };
  const message = (found: string) => `it mentions a date that isn't in the facts: ${found}`;

  it("accepts what the local model really wrote: May 15, 2027 for 15 May 2027", () => {
    const draft = {
      subject: "Acme website security updates",
      body: "I'll be performing security updates for your website on May 15, 2027. The estimated cost is USD 200.00.",
    };
    expect(draftProblems(draft, maintenance)).toEqual([]);
  });

  it("refuses the same sentence with a date that isn't in the facts", () => {
    const draft = { subject: "Heads-up", body: "This is on May 16, 2027. Estimate USD 200.00." };
    expect(draftProblems(draft, maintenance)).toEqual([message("May 16, 2027")]);
  });

  it("checks the subject too", () => {
    const draft = { subject: "Due 1 Nov 2026", body: `It was due on 31 Oct 2026.\n${PAY_LINK}` };
    expect(draftProblems(draft, reminder)).toEqual([message("1 Nov 2026")]);
  });

  it("refuses an invented deadline on a reminder", () => {
    const draft = { subject: "Invoice", body: `Please pay by next Friday.\n${PAY_LINK}` };
    expect(draftProblems(draft, reminder)).toEqual([message("next Friday")]);
  });

  it("accepts a date from the contract terms", () => {
    const request: DraftRequest = {
      kind: "tier2",
      facts: reminderFacts({ contractTerms: "Final payment by 20 Dec 2026." }),
    };
    const draft = { subject: "Invoice", body: `We agreed on 20 Dec 2026.\n${PAY_LINK}` };
    expect(draftProblems(draft, request)).toEqual([]);
  });

  it("accepts a date inside the citation it was given", () => {
    const request: DraftRequest = {
      kind: "tier3",
      facts: reminderFacts({
        citation: { kind: "contract", text: "Late fees apply from 1 Jan 2027." },
      }),
    };
    const draft = {
      subject: "Final notice",
      body: `Late fees apply from 1 Jan 2027.\n${PAY_LINK}`,
    };
    expect(draftProblems(draft, request)).toEqual([]);
  });

  it("a project name holding a date doesn't count against the draft", () => {
    const request: DraftRequest = {
      kind: "tier1",
      facts: reminderFacts({ projectTitle: "June 2028 launch" }),
    };
    const draft = { subject: "June 2028 launch", body: `About June 2028 launch.\n${PAY_LINK}` };
    expect(draftProblems(draft, request)).toEqual([]);
  });

  it("every fixed template passes, so a draft always exists", () => {
    const facts = reminderFacts({ daysOverdue: 14 });
    for (const kind of ["courtesy", "tier1", "tier2", "tier3"] as const) {
      const request: DraftRequest = { kind, facts };
      expect(draftProblems(draftTemplate(request), request)).toEqual([]);
    }
    expect(draftProblems(draftTemplate(maintenance), maintenance)).toEqual([]);
  });

  it("a date the freelancer named in a plain-word edit is allowed for that redraft", () => {
    const draft = { subject: "Heads-up", body: "This moves to the 20th. Estimate USD 200.00." };
    expect(draftProblems(draft, maintenance)).toHaveLength(1);
    expect(draftProblems(draft, maintenance, [], { alsoAllowed: ["mention the 20th"] })).toEqual(
      [],
    );
  });

  it("the router treats a wrong date as an invalid answer", () => {
    const schema = checkedDraftSchema(maintenance);
    expect(
      schema.safeParse({ subject: "Heads-up", body: "On May 16, 2027. USD 200.00." }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ subject: "Heads-up", body: "On May 15, 2027. USD 200.00." }).success,
    ).toBe(true);
  });
});
