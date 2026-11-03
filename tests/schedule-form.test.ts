import { describe, expect, it } from "vitest";
import { formatPercent, parseDateList, parsePercent, setOverride } from "@/lib/schedule-form";
import { DEFAULT_SETTINGS } from "@/lib/settings";

describe("setOverride", () => {
  it("stores a value that differs from the inherited one", () => {
    expect(setOverride({}, DEFAULT_SETTINGS, "graceDays", 3)).toEqual({ graceDays: 3 });
  });

  it("drops the override when the value matches what's inherited again", () => {
    expect(setOverride({ graceDays: 3 }, DEFAULT_SETTINGS, "graceDays", 0)).toEqual({});
    expect(
      setOverride(
        { sendWindow: { days: [1, 2], start: "09:00", end: "17:00" } },
        DEFAULT_SETTINGS,
        "sendWindow",
        { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      ),
    ).toEqual({});
  });

  it("keeps an explicit 'off' (null) when the inherited value is on", () => {
    expect(setOverride({}, DEFAULT_SETTINGS, "preDueDays", null)).toEqual({ preDueDays: null });
  });

  it("doesn't change the object it was given", () => {
    const value = { graceDays: 3 };
    setOverride(value, DEFAULT_SETTINGS, "maxPerTier", 4);
    expect(value).toEqual({ graceDays: 3 });
  });
});

describe("parsePercent and formatPercent", () => {
  it("turns a typed percentage into basis points without floats", () => {
    expect(parsePercent("1.5")).toBe(150);
    expect(parsePercent(" 2 ")).toBe(200);
    expect(parsePercent("0.25")).toBe(25);
  });

  it("returns NaN for text it can't read, so validation flags it", () => {
    for (const text of ["", "abc", "1.255", "-1"]) expect(parsePercent(text), text).toBeNaN();
  });

  it("shows basis points as a percentage", () => {
    expect(formatPercent(150)).toBe("1.5");
    expect(formatPercent(200)).toBe("2");
    expect(formatPercent(25)).toBe("0.25");
  });
});

describe("parseDateList", () => {
  it("splits dates on commas, spaces or new lines", () => {
    expect(parseDateList("2026-12-04, 2026-12-11\n2026-12-18")).toEqual([
      "2026-12-04",
      "2026-12-11",
      "2026-12-18",
    ]);
    expect(parseDateList("  ")).toEqual([]);
  });
});
