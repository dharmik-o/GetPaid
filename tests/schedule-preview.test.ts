import { describe, expect, it } from "vitest";
import { describeSchedule } from "@/lib/schedule-preview";
import { mergeSettings } from "@/lib/settings";

const NY = "America/New_York";
// Deadline Wed 18 Nov 2026; Net 14 makes the due date Wed 2 Dec.
const context = { deadline: "2026-11-18", timeZone: NY };
const plain = (text: string): string => text.replace(/\s/gu, " ");

describe("describeSchedule", () => {
  it("describes the default schedule in client time", () => {
    expect(plain(describeSchedule(mergeSettings({}), context))).toBe(
      "If you invoice on 18 Nov, payment is due 2 Dec. " +
        "Courtesy note: Mon 30 Nov, 09:00 client time. " +
        "First reminder: Thu 3 Dec, 09:00 client time, then every 3 days.",
    );
  });

  it("leaves out the courtesy note when it's off, and follows the grace period", () => {
    const settings = mergeSettings({ project: { preDueDays: null, graceDays: 3 } });
    expect(plain(describeSchedule(settings, context))).toBe(
      "If you invoice on 18 Nov, payment is due 2 Dec. " +
        "First reminder: Mon 7 Dec, 09:00 client time, then every 3 days.",
    );
  });

  it("mentions specific dates instead of an interval", () => {
    const settings = mergeSettings({
      project: {
        preDueDays: null,
        interval: { kind: "dates", dates: ["2026-12-04", "2026-12-11"] },
      },
    });
    expect(plain(describeSchedule(settings, context))).toContain(
      "First reminder: Fri 4 Dec, 09:00 client time, then on the dates you picked.",
    );
  });

  it("says when reminders are paused", () => {
    const settings = mergeSettings({ project: { paused: true } });
    expect(describeSchedule(settings, context)).toBe(
      "Reminders are paused. Nothing is sent until you resume them.",
    );
  });

  it("asks for a deadline and a client first", () => {
    expect(describeSchedule(mergeSettings({}), { deadline: "", timeZone: NY })).toBe(
      "Add a deadline and a client to see when reminders go out.",
    );
  });
});

describe("describeSchedule before the invoice exists", () => {
  it("never previews a courtesy note before the invoice goes out on the deadline", () => {
    // Net 7 with a 30-day pre-due note: the note's day is before the deadline, so it's sent on the deadline.
    const settings = mergeSettings({
      project: { paymentTerms: { kind: "net", days: 7 }, preDueDays: 30 },
    });
    expect(
      describeSchedule(settings, {
        deadline: "2026-11-18",
        timeZone: "Pacific/Kiritimati",
      }).replace(/\s/gu, " "),
    ).toContain("Courtesy note: Wed 18 Nov, 09:00 client time.");
  });
});
