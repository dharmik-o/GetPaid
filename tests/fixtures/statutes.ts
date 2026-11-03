import type { Law } from "@/lib/legal";

// A made-up law table for tests only. The real one is legal/statutes.json, and its entries
// are added only after a person checks them (see .claude/rules/prompts.md).

export const TEST_LAWS: Law[] = [
  {
    id: "test-gb-late-payment",
    name: "Test Late Payment Act 2000",
    countries: ["GB"],
    citation:
      "Under the Test Late Payment Act 2000, statutory interest may apply to late payments.",
    sourceUrl: "https://example.test/laws/gb",
    checkedOn: "2026-11-03",
  },
  {
    id: "test-us-city-only",
    name: "Test City Freelancer Act",
    countries: ["US"],
    citation: "Under the Test City Freelancer Act, payment is due within 30 days.",
    sourceUrl: "https://example.test/laws/us-city",
    checkedOn: "2026-11-03",
    condition: "Only when the freelancer or client is in Test City.",
  },
];
