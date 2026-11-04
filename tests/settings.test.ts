import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "@/lib/settings";

describe("DEFAULT_SETTINGS", () => {
  it("matches the defaults in the spec's project setup table", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      paymentTerms: { kind: "net", days: 14 },
      preDueDays: 2,
      graceDays: 0,
      interval: { kind: "every", days: 3 },
      maxPerTier: 2,
      nudgeHours: 24,
      tierBoundaries: { tier1: 1, tier2: 8, tier3: 22 },
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      lateFee: null,
      approvalMode: "approve_all",
      paused: false,
      snoozeUntil: null,
    });
  });

  it("can't be changed by a caller", () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    const merged = mergeSettings({});
    merged.sendWindow.days.push(6);
    expect(DEFAULT_SETTINGS.sendWindow.days).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("mergeSettings", () => {
  it("returns the defaults when no layer sets anything", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ account: {}, client: null, project: undefined })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("lets the account override the defaults", () => {
    expect(mergeSettings({ account: { graceDays: 3 } }).graceDays).toBe(3);
  });

  it("lets the client override the account", () => {
    const merged = mergeSettings({ account: { graceDays: 3 }, client: { graceDays: 5 } });
    expect(merged.graceDays).toBe(5);
  });

  it("lets the project override the client", () => {
    const merged = mergeSettings({
      account: { maxPerTier: 3 },
      client: { maxPerTier: 4 },
      project: { maxPerTier: 1 },
    });
    expect(merged.maxPerTier).toBe(1);
  });

  it("lets the milestone override the project", () => {
    const merged = mergeSettings({
      client: { paymentTerms: { kind: "net", days: 30 } },
      project: { paymentTerms: { kind: "net", days: 7 } },
      milestone: { paymentTerms: { kind: "on_receipt" } },
    });
    expect(merged.paymentTerms).toEqual({ kind: "on_receipt" });
  });

  it("keeps a setting from the layer above when a lower layer doesn't set it", () => {
    const merged = mergeSettings({
      account: { graceDays: 2 },
      client: { approvalMode: "auto_send_tier1" },
      project: { interval: { kind: "every", days: 5 } },
      milestone: {},
    });
    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      graceDays: 2,
      approvalMode: "auto_send_tier1",
      interval: { kind: "every", days: 5 },
    });
  });

  it("treats a key set to undefined as not set, so the layer above still applies", () => {
    const merged = mergeSettings({ client: { graceDays: 4 }, project: { graceDays: undefined } });
    expect(merged.graceDays).toBe(4);
  });

  it("replaces grouped settings as a whole instead of mixing fields from two layers", () => {
    const merged = mergeSettings({
      client: { sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00" } },
      project: { sendWindow: { days: [2, 4], start: "10:00", end: "12:00" } },
    });
    expect(merged.sendWindow).toEqual({ days: [2, 4], start: "10:00", end: "12:00" });
  });

  it("treats null as an explicit 'off' that overrides the layer above", () => {
    const merged = mergeSettings({
      account: { preDueDays: 5, lateFee: { kind: "percent_per_month", basisPoints: 150 } },
      project: { preDueDays: null, lateFee: null },
    });
    expect(merged.preDueDays).toBeNull();
    expect(merged.lateFee).toBeNull();
  });

  it("keeps money in integer cents for a flat late fee", () => {
    const merged = mergeSettings({ project: { lateFee: { kind: "flat", amountCents: 2500 } } });
    expect(merged.lateFee).toEqual({ kind: "flat", amountCents: 2500 });
    expect(() =>
      mergeSettings({ project: { lateFee: { kind: "flat", amountCents: 25.5 } } }),
    ).toThrow(/lateFee/);
  });

  describe("pause and snooze", () => {
    it("pauses when any layer is paused, so a lower layer can't resume a paused client", () => {
      expect(mergeSettings({ client: { paused: true } }).paused).toBe(true);
      expect(mergeSettings({ client: { paused: true }, project: { paused: false } }).paused).toBe(
        true,
      );
      expect(mergeSettings({ milestone: { paused: true } }).paused).toBe(true);
      expect(mergeSettings({ client: { paused: false } }).paused).toBe(false);
    });

    it("snoozes until the latest date set on any layer", () => {
      const merged = mergeSettings({
        client: { snoozeUntil: "2026-12-20" },
        project: { snoozeUntil: "2026-12-05" },
        milestone: { snoozeUntil: null },
      });
      expect(merged.snoozeUntil).toBe("2026-12-20");
      expect(mergeSettings({ project: { snoozeUntil: "2027-01-02" } }).snoozeUntil).toBe(
        "2027-01-02",
      );
    });
  });

  describe("invalid stored settings", () => {
    it("names the layer and the field, and says what to do next", () => {
      expect(() => mergeSettings({ client: { graceDays: "three" } })).toThrow(
        /client settings.*graceDays.*save/is,
      );
    });

    it("rejects a misspelled or unknown setting instead of ignoring it", () => {
      expect(() => mergeSettings({ project: { gracedays: 3 } })).toThrow(/project settings/);
    });

    it("rejects a layer that isn't an object", () => {
      expect(() => mergeSettings({ milestone: [1, 2] })).toThrow(/milestone settings/);
    });
  });
});
