import { describe, expect, it } from "vitest";
import { mergeSettings } from "@/lib/settings";
import { validateSettings, type FieldIssue } from "@/lib/settings-validation";

const errorsFor = (raw: unknown, context = {}): FieldIssue[] => {
  const result = validateSettings(raw, context);
  if (result.ok) throw new Error("expected the settings to be rejected");
  return result.errors;
};

const fields = (issues: FieldIssue[]): string[] => issues.map((issue) => issue.field);

describe("validateSettings", () => {
  it("accepts valid settings and returns them parsed", () => {
    const raw = { graceDays: 2, tierBoundaries: { tier1: 1, tier2: 8, tier3: 22 } };
    expect(validateSettings(raw)).toEqual({ ok: true, settings: raw, warnings: [] });
  });

  it("accepts an empty override (everything inherited)", () => {
    expect(validateSettings({})).toEqual({ ok: true, settings: {}, warnings: [] });
  });

  describe("tier boundaries", () => {
    it("rejects Tier 2 that doesn't start after Tier 1", () => {
      const errors = errorsFor({ tierBoundaries: { tier1: 5, tier2: 5, tier3: 22 } });
      expect(errors).toEqual([
        { field: "tierBoundaries.tier2", message: "must start after Tier 1 (day 5)" },
      ]);
    });

    it("rejects Tier 3 that doesn't start after Tier 2", () => {
      const errors = errorsFor({ tierBoundaries: { tier1: 1, tier2: 10, tier3: 8 } });
      expect(errors).toEqual([
        { field: "tierBoundaries.tier3", message: "must start after Tier 2 (day 10)" },
      ]);
    });

    it("rejects a tier that starts before day 1", () => {
      expect(fields(errorsFor({ tierBoundaries: { tier1: 0, tier2: 8, tier3: 22 } }))).toEqual([
        "tierBoundaries.tier1",
      ]);
    });

    it("is also enforced when merging saved settings", () => {
      expect(() =>
        mergeSettings({ client: { tierBoundaries: { tier1: 8, tier2: 1, tier3: 22 } } }),
      ).toThrow(/tierBoundaries\.tier2 must start after Tier 1/);
    });
  });

  describe("reminder interval", () => {
    it("rejects an interval under 1 day", () => {
      expect(errorsFor({ interval: { kind: "every", days: 0 } })).toEqual([
        { field: "interval.days", message: "must be at least 1 day" },
      ]);
    });

    it("rejects part days", () => {
      expect(fields(errorsFor({ interval: { kind: "every", days: 1.5 } }))).toEqual([
        "interval.days",
      ]);
    });

    it("needs at least one date when using specific dates", () => {
      expect(errorsFor({ interval: { kind: "dates", dates: [] } })).toEqual([
        { field: "interval.dates", message: "needs at least one date" },
      ]);
    });

    it("rejects a badly formatted date with its position", () => {
      expect(
        fields(errorsFor({ interval: { kind: "dates", dates: ["2026-12-01", "12/15"] } })),
      ).toEqual(["interval.dates.1"]);
    });
  });

  describe("send window", () => {
    it("rejects an end time that isn't after the start", () => {
      expect(errorsFor({ sendWindow: { days: [1, 2], start: "17:00", end: "09:00" } })).toEqual([
        { field: "sendWindow.end", message: "must be after the start time (17:00)" },
      ]);
    });

    it("rejects a day listed twice", () => {
      expect(
        fields(errorsFor({ sendWindow: { days: [1, 1, 2], start: "09:00", end: "17:00" } })),
      ).toEqual(["sendWindow.days"]);
    });

    it("rejects a time that isn't HH:MM", () => {
      expect(errorsFor({ sendWindow: { days: [1], start: "9am", end: "17:00" } })).toEqual([
        { field: "sendWindow.start", message: "must be a 24-hour time like 09:00" },
      ]);
    });
  });

  describe("other fields", () => {
    it("reports every invalid field at once, each with its own message", () => {
      const errors = errorsFor({ graceDays: 15, maxPerTier: 0, preDueDays: 0 });
      expect(errors).toEqual([
        { field: "preDueDays", message: "must be at least 1 day" },
        { field: "graceDays", message: "must be 14 days or fewer" },
        { field: "maxPerTier", message: "must be at least 1" },
      ]);
    });

    it("rejects Net terms the spec doesn't offer", () => {
      expect(errorsFor({ paymentTerms: { kind: "net", days: 10 } })).toEqual([
        { field: "paymentTerms.days", message: "must be Net 7, 14, 30, 45 or 60" },
      ]);
    });

    it("names an unknown setting", () => {
      expect(errorsFor({ gracedays: 3 })).toEqual([
        { field: "gracedays", message: "isn't a known setting" },
      ]);
    });

    it("rejects a value of the wrong type", () => {
      expect(fields(errorsFor({ graceDays: "3" }))).toEqual(["graceDays"]);
    });

    it("rejects input that isn't an object", () => {
      expect(fields(errorsFor("weekly"))).toEqual(["settings"]);
    });
  });

  describe("late fee", () => {
    const lateFee = { kind: "percent_per_month", basisPoints: 150 };

    it("is rejected on a project whose contract has no late-fee clause", () => {
      expect(errorsFor({ lateFee }, { contractHasLateFee: false })).toEqual([
        {
          field: "lateFee",
          message: "needs a late-fee clause in the contract. Add the clause to the project first.",
        },
      ]);
    });

    it("is allowed when the contract has a clause, or when turned off", () => {
      expect(validateSettings({ lateFee }, { contractHasLateFee: true }).ok).toBe(true);
      expect(validateSettings({ lateFee: null }, { contractHasLateFee: false }).ok).toBe(true);
    });

    it("is allowed as an account or client default, where there's no contract yet", () => {
      expect(validateSettings({ lateFee }).ok).toBe(true);
    });
  });

  describe("due date before the delivery deadline", () => {
    const warning = {
      field: "paymentTerms",
      message:
        "The payment due date (2026-11-10) is before the delivery deadline (2026-11-20). " +
        "You can still save; check this is what you agreed with the client.",
    };

    it("warns, without blocking, for a specific due date", () => {
      const result = validateSettings(
        { paymentTerms: { kind: "date", date: "2026-11-10" } },
        { deadline: "2026-11-20" },
      );
      expect(result).toEqual({
        ok: true,
        settings: { paymentTerms: { kind: "date", date: "2026-11-10" } },
        warnings: [warning],
      });
    });

    it("works out the due date from Net terms when the issue date is known", () => {
      const result = validateSettings(
        { paymentTerms: { kind: "net", days: 7 } },
        { deadline: "2026-11-20", issuedOn: "2026-11-03" },
      );
      expect(result.warnings).toEqual([warning]);
    });

    it("uses the terms inherited from the layers above", () => {
      const parent = mergeSettings({
        client: { paymentTerms: { kind: "date", date: "2026-11-10" } },
      });
      expect(validateSettings({}, { deadline: "2026-11-20", parent }).warnings).toEqual([warning]);
    });

    it("doesn't warn when the due date is on or after the deadline, or unknown", () => {
      const onTime = { paymentTerms: { kind: "date", date: "2026-11-20" } };
      expect(validateSettings(onTime, { deadline: "2026-11-20" }).warnings).toEqual([]);
      // Net terms with no issue date yet: the due date isn't known.
      expect(
        validateSettings({ paymentTerms: { kind: "net", days: 7 } }, { deadline: "2026-11-20" })
          .warnings,
      ).toEqual([]);
    });

    it("still reports the warning next to errors", () => {
      const result = validateSettings(
        { paymentTerms: { kind: "date", date: "2026-11-10" }, graceDays: 99 },
        { deadline: "2026-11-20" },
      );
      expect(result.ok).toBe(false);
      expect(result.warnings).toEqual([warning]);
    });
  });
});
