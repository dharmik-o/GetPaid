import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLegalFacts } from "@/lib/account";
import { createClient, parseClientCreate, parseClientUpdate, updateClient } from "@/lib/clients";
import { runAsUser } from "@/lib/db";
import { lawApplies, parseStatuteTable, pickCitation, type Law, type LawFacts } from "@/lib/legal";
import { REFERENCE_RATE_TABLE } from "@/lib/reference-rate-table";
import { parseReferenceRates, rateOn } from "@/lib/reference-rates";
import { REFERENCE_RATES } from "@/lib/statutes";
import { readRatesFile } from "../../scripts/lib/prompt-source";
import { USER_A, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// C-S4: an unapproved law is never cited, and a law is cited only when the stored facts meet
// every one of its conditions. Plus the reference-rate lookup that statutory interest relies on.

const base = {
  name: "Test Freelance Act",
  citation: "Under the Test Freelance Act, payment is due within 30 days.",
  sourceUrl: "https://example.test/law",
  checkedOn: "2026-11-09",
  approved: true,
};

const law = (id: string, country: string, extra: Record<string, unknown> = {}): Law => {
  const [parsed] = parseStatuteTable({ laws: [{ ...base, id, countries: [country], ...extra }] });
  if (!parsed) throw new Error("test law did not parse");
  return parsed;
};

const FACTS: LawFacts = {
  clientRegion: "NY",
  clientIsBusiness: true,
  freelancerHasUdyam: true,
  amountCents: 90_000,
  currency: "USD",
};

const cite = (laws: Law[], country: string, facts: Partial<LawFacts> = {}) =>
  pickCitation({ lateFeeClause: null, country, facts: { ...FACTS, ...facts }, laws });

describe("legal gating (C-S4)", () => {
  it("never cites an unapproved law, and a law is unapproved unless it says otherwise", () => {
    expect(cite([law("test-gb", "GB", { approved: false })], "GB")).toBeNull();
    const withoutFlag = { ...base, id: "test-gb", countries: ["GB"], approved: undefined };
    expect(parseStatuteTable({ laws: [withoutFlag] })[0]?.approved).toBe(false);
  });

  it("cites an approved law whose conditions are all met", () => {
    const ny = law("test-ny", "US", {
      appliesWhen: { clientRegions: ["NY"], minAmountCents: 80_000, amountCurrency: "USD" },
    });
    expect(cite([ny], "US")).toEqual({ kind: "statute", lawId: "test-ny", text: base.citation });
  });

  it.each([
    ["the wrong region", { clientRegion: "TX" }],
    ["no region", { clientRegion: null }],
    ["an amount under the threshold", { amountCents: 79_999 }],
    ["another currency", { currency: "GBP" }],
  ])("does not cite a regional law with %s", (_label, facts) => {
    const ny = law("test-ny", "US", {
      appliesWhen: { clientRegions: ["NY"], minAmountCents: 80_000, amountCurrency: "USD" },
    });
    expect(cite([ny], "US", facts)).toBeNull();
  });

  it("does not cite a business-only law for a private client", () => {
    const uk = law("test-uk", "GB", { appliesWhen: { clientIsBusiness: true } });
    expect(cite([uk], "GB")).not.toBeNull();
    expect(cite([uk], "GB", { clientIsBusiness: false })).toBeNull();
  });

  it("does not cite an Udyam-only law when the freelancer has no Udyam number", () => {
    const msmed = law("test-in", "IN", { appliesWhen: { freelancerHasUdyam: true } });
    expect(cite([msmed], "IN")).not.toBeNull();
    expect(cite([msmed], "IN", { freelancerHasUdyam: false })).toBeNull();
  });

  it("never matches a threshold that has no currency to compare in", () => {
    const loose = law("test-us", "US", { appliesWhen: { minAmountCents: 1 } });
    expect(lawApplies(loose, "US", FACTS)).toBe(false);
  });

  it("never auto-cites a law with a condition the app can't check", () => {
    expect(
      cite([law("test-city", "US", { condition: "Only inside Test City." })], "US"),
    ).toBeNull();
  });

  it("skips a law that doesn't apply and cites the next one that does", () => {
    const first = law("test-first", "US", { appliesWhen: { clientRegions: ["IL"] } });
    const second = law("test-second", "US", { appliesWhen: { clientRegions: ["NY"] } });
    expect(cite([first, second], "US")).toMatchObject({ lawId: "test-second" });
  });
});

describe("reference rates", () => {
  const rates = parseReferenceRates({
    BOE_BASE: [
      {
        from: "2025-01-01",
        bp: 450,
        source: "https://example.test/r",
        checkedOn: "2026-11-09",
        approved: true,
      },
      {
        from: "2025-06-01",
        bp: 425,
        source: "https://example.test/r",
        checkedOn: "2026-11-09",
        approved: true,
      },
      { from: "2025-09-01", bp: 400, source: "https://example.test/r", checkedOn: "2026-11-09" },
    ],
    ECB_MRO: [],
    RBI_BANK: [],
  });

  it("returns the approved rate in force on a date", () => {
    expect(rateOn(rates, "BOE_BASE", "2025-05-31")).toBe(450);
    expect(rateOn(rates, "BOE_BASE", "2025-06-01")).toBe(425);
  });

  it("returns null before the first entry, with no entries, or when the rate in force is unapproved", () => {
    expect(rateOn(rates, "BOE_BASE", "2024-12-31")).toBeNull();
    expect(rateOn(rates, "ECB_MRO", "2025-05-31")).toBeNull();
    expect(rateOn(rates, "BOE_BASE", "2025-09-02")).toBeNull();
  });

  it("matches lib/reference-rate-table.ts (run npm run ai:prompts) and parses", () => {
    expect(REFERENCE_RATE_TABLE).toEqual(readRatesFile());
    expect(REFERENCE_RATES.BOE_BASE.length).toBeGreaterThan(0);
  });

  it("refuses a malformed table, naming the file", () => {
    expect(() =>
      parseReferenceRates({ BOE_BASE: [{ from: "x" }], ECB_MRO: [], RBI_BANK: [] }),
    ).toThrow(/reference-rates\.json is not valid/);
  });
});

describe("stored legal facts", () => {
  let handle: TestDatabase;
  beforeAll(async () => {
    handle = await openMigratedPglite();
    await handle.db.query(seedOwnerSql(USER_A));
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  const as = <T>(work: Parameters<typeof runAsUser<T>>[2]) =>
    runAsUser(handle.db, USER_A.userId, work);
  const ok = <T>(parsed: { ok: true; value: T } | { ok: false }): T => {
    if (!parsed.ok) throw new Error("expected valid input");
    return parsed.value;
  };

  it("saves a client's region and business flag, and keeps them on an unrelated edit", async () => {
    const input = {
      name: "Acme",
      email: "a@example.test",
      country: "US",
      region: "ny",
      isBusiness: false,
    };
    const client = await as((db) => createClient(db, ok(parseClientCreate(input))));
    expect(client).toMatchObject({ region: "NY", isBusiness: false });
    const renamed = await as((db) =>
      updateClient(db, client.id, ok(parseClientUpdate({ name: "Acme 2" }))),
    );
    expect(renamed).toMatchObject({ region: "NY", isBusiness: false });
    const cleared = await as((db) =>
      updateClient(db, client.id, ok(parseClientUpdate({ region: null }))),
    );
    expect(cleared?.region).toBeNull();
  });

  it("defaults a new client to a business with no region, and refuses a bad region", async () => {
    const client = await as((db) =>
      createClient(
        db,
        ok(parseClientCreate({ name: "B", email: "b@example.test", country: "GB" })),
      ),
    );
    expect(client).toMatchObject({ region: null, isBusiness: true });
    expect(
      parseClientCreate({ name: "B", email: "b@example.test", country: "US", region: "New York" })
        .ok,
    ).toBe(false);
  });

  it("has no legal details until the freelancer enters them", async () => {
    expect(await as((db) => getLegalFacts(db))).toEqual({
      legalName: null,
      udyamNumber: null,
      governingLawCountry: null,
    });
  });
});
