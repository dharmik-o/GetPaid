import { describe, expect, it } from "vitest";
import { draftProblems } from "@/lib/draft-checks";
import { draftTemplate } from "@/lib/draft-templates";
import { legalProblem, parseStatuteTable, pickCitation } from "@/lib/legal";
import { STATUTE_TABLE } from "@/lib/statute-table";
import { STATUTES } from "@/lib/statutes";
import { readStatuteFile } from "../scripts/lib/prompt-source";
import { PAY_LINK, reminderFacts } from "./fixtures/draft-facts";
import { TEST_LAWS } from "./fixtures/statutes";

// Legal gating: Tier 3 cites only the contract's clause or a law from legal/statutes.json for
// the client's country; otherwise it's a plain final notice that cites nothing.

const [GB_LAW] = TEST_LAWS;

describe("legal/statutes.json", () => {
  it("matches lib/statute-table.ts (run npm run ai:prompts)", () => {
    expect(STATUTE_TABLE).toEqual(readStatuteFile());
  });

  it("is a valid table", () => {
    expect(Array.isArray(STATUTES)).toBe(true);
  });

  it.each([
    ["a source that isn't https", { sourceUrl: "http://example.test/law" }],
    ["no checked date", { checkedOn: undefined }],
    ["a lowercase country", { countries: ["gb"] }],
    ["no countries", { countries: [] }],
    ["an unknown field", { fee: "8%" }],
  ])("refuses an entry with %s", (_label, change) => {
    const law = { ...GB_LAW, ...change };
    expect(() => parseStatuteTable({ laws: [law] })).toThrow(/statutes\.json is not valid/);
  });
});

describe("pickCitation", () => {
  it("cites nothing for a country missing from the table", () => {
    expect(pickCitation({ lateFeeClause: null, country: "JP", laws: TEST_LAWS })).toBeNull();
  });

  it("cites nothing with an empty table", () => {
    expect(pickCitation({ lateFeeClause: null, country: "GB", laws: [] })).toBeNull();
  });

  it("cites the law for the client's country, in the table's own words", () => {
    expect(pickCitation({ lateFeeClause: null, country: "GB", laws: TEST_LAWS })).toEqual({
      kind: "statute",
      lawId: "test-gb-late-payment",
      text: GB_LAW?.citation,
    });
  });

  it("never cites a law with a condition the app can't check", () => {
    expect(pickCitation({ lateFeeClause: null, country: "US", laws: TEST_LAWS })).toBeNull();
  });

  it("prefers the contract's own clause, quoted as written", () => {
    expect(
      pickCitation({
        lateFeeClause: "  1.5% per\nmonth on late invoices. ",
        country: "GB",
        laws: TEST_LAWS,
      }),
    ).toEqual({
      kind: "contract",
      text: `Our contract's late-payment clause says: "1.5% per month on late invoices."`,
    });
  });

  it("treats a blank clause as none", () => {
    expect(pickCitation({ lateFeeClause: "   ", country: "JP", laws: TEST_LAWS })).toBeNull();
  });
});

describe("legalProblem", () => {
  const none = { citation: null, contractTerms: null, laws: TEST_LAWS };

  it.each([
    "Under the Late Payment of Commercial Debts (Interest) Act 1998 you owe interest.",
    "Interest will be added.",
    "A late fee now applies.",
    "I will take this to court.",
    "My lawyer will be in touch.",
    "This goes to a collection agency next.",
    "The EU Directive is clear.",
    "Test Late Payment Act 2000",
  ])("with no citation, refuses: %s", (text) => {
    expect(legalProblem(text, none)).toMatch(/may cite nothing/);
  });

  it.each(["Please act on this today.", "This is a final notice.", "Our agreed terms are Net 14."])(
    "allows plain words: %s",
    (text) => {
      expect(legalProblem(text, none)).toBeUndefined();
    },
  );

  it("allows the given citation, and nothing else", () => {
    const citation = {
      kind: "statute" as const,
      lawId: "test-gb-late-payment",
      text: GB_LAW?.citation ?? "",
    };
    const given = { citation, contractTerms: null, laws: TEST_LAWS };
    expect(legalProblem(`Final notice. ${citation.text}`, given)).toBeUndefined();
    expect(legalProblem(`${citation.text} A late fee applies too.`, given)).toMatch(
      /other than the given citation/,
    );
  });

  it("allows contract terms quoted from the facts", () => {
    const terms = "This agreement is governed by the laws of England.";
    expect(legalProblem(`As agreed: ${terms}`, { ...none, contractTerms: terms })).toBeUndefined();
  });
});

describe("Tier 3 drafts", () => {
  const facts = reminderFacts({ daysOverdue: 25 });
  const cites = {
    subject: "Final notice: invoice FPR-000042",
    body: `USD 1,500.00. ${GB_LAW?.citation ?? ""}\n${PAY_LINK}`,
  };

  it("refuses a legal citation when the facts give none (country not in the table)", () => {
    expect(draftProblems(cites, { kind: "tier3", facts }, TEST_LAWS)).toContain(
      "it makes a legal or fee reference, but this notice may cite nothing",
    );
  });

  it("accepts the citation it was given", () => {
    const citation = pickCitation({ lateFeeClause: null, country: "GB", laws: TEST_LAWS });
    expect(
      draftProblems(cites, { kind: "tier3", facts: { ...facts, citation } }, TEST_LAWS),
    ).toEqual([]);
  });

  it("Tiers 1 and 2 may never cite, even with a citation in the facts", () => {
    const citation = pickCitation({ lateFeeClause: null, country: "GB", laws: TEST_LAWS });
    expect(
      draftProblems(cites, { kind: "tier2", facts: { ...facts, citation } }, TEST_LAWS),
    ).toContain("it makes a legal or fee reference, but this notice may cite nothing");
  });

  it.each(["courtesy", "tier1", "tier2", "tier3"] as const)(
    "the %s template passes the legal check",
    (kind) => {
      const request = { kind, facts };
      expect(draftProblems(draftTemplate(request), request, TEST_LAWS)).toEqual([]);
    },
  );
});
