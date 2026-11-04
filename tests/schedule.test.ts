import { describe, expect, it } from "vitest";
import { mergeSettings, type ReminderInterval, type SettingsOverride } from "@/lib/settings";
import {
  computeDueDate,
  daysOverdue,
  effectiveSendAt,
  invoiceDates,
  localTimeInput,
  nextSend,
  nextWindowSlot,
  rescheduledSendAt,
  type NextSendInput,
  type PastReminder,
} from "@/lib/schedule";

// The client is in New York. In November 2026 that's EST (UTC-5), so 09:00 local = 14:00Z.
const NY = "America/New_York";
// Due Wednesday 18 Nov 2026. Day n overdue = 18 Nov + n days.
const DUE = "2026-11-18";
const EVERY_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "17:00" };

const at = (iso: string): Date => new Date(iso);
const sent = (tier: PastReminder["tier"], iso: string): PastReminder => ({ tier, at: at(iso) });

/** Rule tests use a 7-day window so weekends don't hide the rule under test. */
const plan = (
  overrides: SettingsOverride,
  rest: Partial<Omit<NextSendInput, "settings">> = {},
): ReturnType<typeof nextSend> =>
  nextSend({
    settings: mergeSettings({ account: { sendWindow: EVERY_DAY, ...overrides } }),
    dueDate: DUE,
    timeZone: NY,
    history: [],
    now: at("2026-11-10T12:00:00Z"),
    ...rest,
  });

const scheduled = (tier: string, iso: string) => ({ status: "scheduled", tier, sendAt: at(iso) });

describe("computeDueDate", () => {
  it("is the issue date for due on receipt", () => {
    expect(computeDueDate({ kind: "on_receipt" }, "2026-11-03")).toBe("2026-11-03");
  });

  it("adds the net days, across month and year ends", () => {
    expect(computeDueDate({ kind: "net", days: 14 }, "2026-11-03")).toBe("2026-11-17");
    expect(computeDueDate({ kind: "net", days: 30 }, "2026-12-15")).toBe("2027-01-14");
    expect(computeDueDate({ kind: "net", days: 7 }, "2028-02-25")).toBe("2028-03-03");
  });

  it("uses the specific date as is", () => {
    expect(computeDueDate({ kind: "date", date: "2026-12-01" }, "2026-11-03")).toBe("2026-12-01");
  });
});

describe("invoiceDates", () => {
  it("issues on today's date in the client's zone and applies the terms", () => {
    // 03:00 UTC on 4 Nov is still 3 Nov in New York, and already 4 Nov in Tokyo.
    const now = new Date("2026-11-04T03:00:00Z");
    expect(invoiceDates({ kind: "net", days: 14 }, now, "America/New_York")).toEqual({
      issuedOn: "2026-11-03",
      dueDate: "2026-11-17",
    });
    expect(invoiceDates({ kind: "net", days: 14 }, now, "Asia/Tokyo")).toEqual({
      issuedOn: "2026-11-04",
      dueDate: "2026-11-18",
    });
  });

  it("is due on the issue date for due on receipt", () => {
    const now = new Date("2026-11-03T15:00:00Z");
    expect(invoiceDates({ kind: "on_receipt" }, now, "America/New_York").dueDate).toBe(
      "2026-11-03",
    );
  });

  it("keeps a fixed date, even one in the past (the caller decides what to do)", () => {
    const now = new Date("2026-11-03T15:00:00Z");
    expect(invoiceDates({ kind: "date", date: "2026-11-01" }, now, "UTC")).toEqual({
      issuedOn: "2026-11-03",
      dueDate: "2026-11-01",
    });
  });

  it("rejects an unknown time zone", () => {
    expect(() => invoiceDates({ kind: "on_receipt" }, new Date(), "Mars/Base")).toThrow(
      /Unknown time zone/,
    );
  });
});

describe("nextWindowSlot", () => {
  const window = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

  it("keeps a time that is already inside the window", () => {
    expect(nextWindowSlot(at("2026-11-18T15:30:00Z"), window, NY)).toEqual(
      at("2026-11-18T15:30:00Z"),
    );
  });

  it("moves an early time to the window start the same day", () => {
    expect(nextWindowSlot(at("2026-11-18T06:00:00Z"), window, NY)).toEqual(
      at("2026-11-18T14:00:00Z"),
    );
  });

  it("moves a time at or after the window end to the next day's start", () => {
    expect(nextWindowSlot(at("2026-11-18T22:00:00Z"), window, NY)).toEqual(
      at("2026-11-19T14:00:00Z"),
    );
    expect(nextWindowSlot(at("2026-11-18T23:15:00Z"), window, NY)).toEqual(
      at("2026-11-19T14:00:00Z"),
    );
  });

  it("skips a weekend to Monday morning", () => {
    // Friday 20 Nov, 17:30 local.
    expect(nextWindowSlot(at("2026-11-20T22:30:00Z"), window, NY)).toEqual(
      at("2026-11-23T14:00:00Z"),
    );
    // Saturday 21 Nov, midday local.
    expect(nextWindowSlot(at("2026-11-21T17:00:00Z"), window, NY)).toEqual(
      at("2026-11-23T14:00:00Z"),
    );
  });

  it("uses the client's local day, not the UTC day", () => {
    // 02:00Z Saturday is still Friday 21:00 in New York, after the window, so Monday.
    expect(nextWindowSlot(at("2026-11-21T02:00:00Z"), window, NY)).toEqual(
      at("2026-11-23T14:00:00Z"),
    );
  });

  it("keeps the local start time across the spring DST change", () => {
    // Clocks go forward in New York on Sunday 14 Mar 2027: 09:00 is 14:00Z before, 13:00Z after.
    const everyDay = { ...window, days: EVERY_DAY.days };
    expect(nextWindowSlot(at("2027-03-13T18:00:00Z"), everyDay, NY)).toEqual(
      at("2027-03-13T18:00:00Z"),
    );
    expect(nextWindowSlot(at("2027-03-13T23:00:00Z"), everyDay, NY)).toEqual(
      at("2027-03-14T13:00:00Z"),
    );
  });

  it("moves a window start that doesn't exist on the DST day to the first real time after it", () => {
    const early = { days: EVERY_DAY.days, start: "02:30", end: "05:00" };
    // 02:30 doesn't exist on 14 Mar 2027 in New York; 03:30 EDT (07:30Z) is the next real time.
    expect(nextWindowSlot(at("2027-03-14T05:00:00Z"), early, NY)).toEqual(
      at("2027-03-14T07:30:00Z"),
    );
  });

  it("rejects an unknown time zone with a clear message", () => {
    expect(() => nextWindowSlot(at("2026-11-18T15:00:00Z"), window, "Mars/Olympus")).toThrow(
      /time zone "Mars\/Olympus".*client/i,
    );
  });
});

describe("nextSend", () => {
  describe("pre-due courtesy note", () => {
    it("goes out the set number of days before the due date, at the window start", () => {
      expect(plan({})).toEqual(scheduled("courtesy", "2026-11-16T14:00:00Z"));
      expect(plan({ preDueDays: 5 })).toEqual(scheduled("courtesy", "2026-11-13T14:00:00Z"));
    });

    it("is skipped when turned off", () => {
      expect(plan({ preDueDays: null })).toEqual(scheduled("tier1", "2026-11-19T14:00:00Z"));
    });

    it("is sent only once", () => {
      const history = [sent("courtesy", "2026-11-16T14:00:00Z")];
      expect(plan({}, { history, now: at("2026-11-16T15:00:00Z") })).toEqual(
        scheduled("tier1", "2026-11-19T14:00:00Z"),
      );
    });

    it("still goes out late, as long as it lands on or before the due date", () => {
      expect(plan({}, { now: at("2026-11-18T13:00:00Z") })).toEqual(
        scheduled("courtesy", "2026-11-18T14:00:00Z"),
      );
    });

    it("is dropped once it can't land by the due date", () => {
      // 18:00 local on the due date: the window has closed, so Tier 1 the next morning.
      expect(plan({}, { now: at("2026-11-18T23:00:00Z") })).toEqual(
        scheduled("tier1", "2026-11-19T14:00:00Z"),
      );
    });

    it("moves off a weekend to the next window day if that's still by the due date", () => {
      // Due Monday 16 Nov; 2 days before is Saturday 14 Nov.
      const result = nextSend({
        settings: mergeSettings({}),
        dueDate: "2026-11-16",
        timeZone: NY,
        history: [],
        now: at("2026-11-10T12:00:00Z"),
      });
      expect(result).toEqual(scheduled("courtesy", "2026-11-16T14:00:00Z"));
    });
  });

  describe("grace period", () => {
    it("holds Tier 1 until the grace days have passed", () => {
      expect(plan({ preDueDays: null, graceDays: 3 })).toEqual(
        scheduled("tier1", "2026-11-22T14:00:00Z"),
      );
    });

    it("never starts Tier 1 before its boundary", () => {
      expect(
        plan({ preDueDays: null, graceDays: 1, tierBoundaries: { tier1: 4, tier2: 8, tier3: 22 } }),
      ).toEqual(scheduled("tier1", "2026-11-22T14:00:00Z"));
    });
  });

  describe("interval and max per tier", () => {
    it("waits the interval after the last reminder, counted in the client's calendar days", () => {
      const history = [sent("tier1", "2026-11-19T21:30:00Z")]; // 16:30 local on day 1
      expect(plan({}, { history, now: at("2026-11-19T22:00:00Z") })).toEqual(
        scheduled("tier1", "2026-11-22T14:00:00Z"),
      );
      expect(
        plan(
          { interval: { kind: "every", days: 1 } },
          { history, now: at("2026-11-19T22:00:00Z") },
        ),
      ).toEqual(scheduled("tier1", "2026-11-20T14:00:00Z"));
    });

    it("sends right away inside the window when the next reminder is already due", () => {
      const history = [sent("tier1", "2026-11-19T14:00:00Z")];
      expect(plan({}, { history, now: at("2026-11-23T16:10:00Z") })).toEqual(
        scheduled("tier1", "2026-11-23T16:10:00Z"),
      );
    });

    it("moves up a tier at the next boundary once a tier has had its max reminders", () => {
      const history = [
        sent("tier1", "2026-11-19T14:00:00Z"),
        sent("tier1", "2026-11-22T14:00:00Z"),
      ];
      expect(plan({}, { history, now: at("2026-11-22T15:00:00Z") })).toEqual(
        scheduled("tier2", "2026-11-26T14:00:00Z"),
      );
    });

    it("allows more reminders in a tier when max per tier is higher", () => {
      const history = [
        sent("tier1", "2026-11-19T14:00:00Z"),
        sent("tier1", "2026-11-21T14:00:00Z"),
      ];
      expect(
        plan(
          { maxPerTier: 3, interval: { kind: "every", days: 2 } },
          { history, now: at("2026-11-21T15:00:00Z") },
        ),
      ).toEqual(scheduled("tier1", "2026-11-23T14:00:00Z"));
    });

    it("keeps the interval as the minimum gap when moving up a tier", () => {
      const history = [
        sent("tier1", "2026-11-21T14:00:00Z"),
        sent("tier1", "2026-11-24T14:00:00Z"),
      ];
      // Tier 2 starts on day 8 (26 Nov), but the last reminder was day 6, so day 9.
      expect(plan({}, { history, now: at("2026-11-24T15:00:00Z") })).toEqual(
        scheduled("tier2", "2026-11-27T14:00:00Z"),
      );
    });

    it("labels a reminder with the tier for the day it actually goes out", () => {
      const history = [sent("tier1", "2026-11-19T14:00:00Z")];
      expect(
        plan(
          { interval: { kind: "every", days: 10 } },
          { history, now: at("2026-11-19T15:00:00Z") },
        ),
      ).toEqual(scheduled("tier2", "2026-11-29T14:00:00Z"));
    });

    it("never moves back down a tier, even if the boundaries were raised later", () => {
      const history = [sent("tier2", "2026-11-21T14:00:00Z")];
      expect(plan({}, { history, now: at("2026-11-21T15:00:00Z") })).toEqual(
        scheduled("tier2", "2026-11-24T14:00:00Z"),
      );
    });

    it("moves on when a tier already has more reminders than the current max", () => {
      const history = [
        sent("tier1", "2026-11-19T14:00:00Z"),
        sent("tier1", "2026-11-20T14:00:00Z"),
        sent("tier1", "2026-11-21T14:00:00Z"),
      ];
      expect(plan({}, { history, now: at("2026-11-21T15:00:00Z") })).toEqual(
        scheduled("tier2", "2026-11-26T14:00:00Z"),
      );
    });
  });

  describe("tier boundaries", () => {
    it("uses custom boundaries", () => {
      const tierBoundaries = { tier1: 1, tier2: 4, tier3: 10 };
      const history = [
        sent("tier1", "2026-11-19T14:00:00Z"),
        sent("tier1", "2026-11-20T14:00:00Z"),
      ];
      expect(
        plan(
          { tierBoundaries, interval: { kind: "every", days: 1 } },
          { history, now: at("2026-11-20T15:00:00Z") },
        ),
      ).toEqual(scheduled("tier2", "2026-11-22T14:00:00Z"));
    });

    it("reaches Tier 3 at its boundary", () => {
      const history = [
        sent("tier2", "2026-11-26T14:00:00Z"),
        sent("tier2", "2026-11-29T14:00:00Z"),
      ];
      expect(plan({}, { history, now: at("2026-11-29T15:00:00Z") })).toEqual(
        scheduled("tier3", "2026-12-10T14:00:00Z"),
      );
    });

    it("is done once Tier 3 has had its max reminders", () => {
      const history = [
        sent("tier3", "2026-12-10T14:00:00Z"),
        sent("tier3", "2026-12-13T14:00:00Z"),
      ];
      expect(plan({}, { history, now: at("2026-12-13T15:00:00Z") })).toEqual({ status: "done" });
    });
  });

  describe("specific reminder dates", () => {
    const interval: ReminderInterval = {
      kind: "dates",
      dates: ["2026-12-10", "2026-11-17", "2026-11-20", "2026-11-27"],
    };

    it("goes out on the next listed date after the due date, in date order", () => {
      expect(plan({ preDueDays: null, interval })).toEqual(
        scheduled("tier1", "2026-11-20T14:00:00Z"),
      );
    });

    it("continues with the next date after the last reminder, with the tier for that day", () => {
      const history = [sent("tier1", "2026-11-20T14:00:00Z")];
      expect(plan({ interval }, { history, now: at("2026-11-20T15:00:00Z") })).toEqual(
        scheduled("tier2", "2026-11-27T14:00:00Z"),
      );
    });

    it("skips dates that were missed and ignores max per tier", () => {
      const history = [sent("tier1", "2026-11-20T14:00:00Z")];
      expect(
        plan({ interval, maxPerTier: 1 }, { history, now: at("2026-12-01T15:00:00Z") }),
      ).toEqual(scheduled("tier3", "2026-12-10T14:00:00Z"));
    });

    it("is done after the last listed date", () => {
      const history = [sent("tier3", "2026-12-10T14:00:00Z")];
      expect(plan({ interval }, { history, now: at("2026-12-10T15:00:00Z") })).toEqual({
        status: "done",
      });
    });
  });

  describe("pause and snooze", () => {
    it("sends nothing while paused", () => {
      expect(plan({ paused: true })).toEqual({ status: "paused" });
    });

    it("waits until the snooze date, then uses the tier for that day", () => {
      expect(plan({ preDueDays: null, snoozeUntil: "2026-11-30" })).toEqual(
        scheduled("tier2", "2026-11-30T14:00:00Z"),
      );
    });

    it("ignores a snooze date that has passed", () => {
      expect(plan({ snoozeUntil: "2026-11-01" })).toEqual(
        scheduled("courtesy", "2026-11-16T14:00:00Z"),
      );
    });
  });

  describe("send window", () => {
    it("moves an overdue reminder that falls on a weekend to Monday", () => {
      // Default Mon-Fri window. Tier 1 day 3 = Saturday 21 Nov; next window is Monday 23 Nov.
      const result = nextSend({
        settings: mergeSettings({ account: { preDueDays: null, graceDays: 2 } }),
        dueDate: DUE,
        timeZone: NY,
        history: [],
        now: at("2026-11-10T12:00:00Z"),
      });
      expect(result).toEqual(scheduled("tier1", "2026-11-23T14:00:00Z"));
    });

    it("keeps 09:00 client time across the autumn DST change", () => {
      // New York leaves DST on Sunday 1 Nov 2026: 09:00 is 13:00Z before, 14:00Z after.
      const history = [sent("tier1", "2026-10-30T13:00:00Z")];
      const result = nextSend({
        settings: mergeSettings({ account: { sendWindow: EVERY_DAY } }),
        dueDate: "2026-10-29",
        timeZone: NY,
        history,
        now: at("2026-10-30T14:00:00Z"),
      });
      expect(result).toEqual(scheduled("tier1", "2026-11-02T14:00:00Z"));
    });

    it("counts days and the window in the client's zone when they're 18 hours ahead of the freelancer", () => {
      // Freelancer in Lima (UTC-5); client in Auckland (NZDT, UTC+13). Due 18 Nov in Auckland.
      // Now is 07:00 on 18 Nov in Lima, but already 01:00 on 19 Nov (day 1) in Auckland.
      const result = nextSend({
        settings: mergeSettings({}),
        dueDate: DUE,
        timeZone: "Pacific/Auckland",
        history: [sent("courtesy", "2026-11-15T20:00:00Z")],
        now: at("2026-11-18T12:00:00Z"),
      });
      // 09:00 on Thu 19 Nov in Auckland = 20:00Z on 18 Nov, still 15:00 on 18 Nov in Lima.
      expect(result).toEqual(scheduled("tier1", "2026-11-18T20:00:00Z"));
    });
  });
});

describe("daysOverdue", () => {
  it("counts calendar days in the client's zone, negative before the due date", () => {
    expect(daysOverdue("2026-11-10", new Date("2026-11-08T15:00:00Z"), "America/New_York")).toBe(
      -2,
    );
    expect(daysOverdue("2026-11-10", new Date("2026-11-10T23:00:00Z"), "America/New_York")).toBe(0);
    // 03:00 UTC on 11 Nov is still 10 Nov in New York, but already 11 Nov in Kolkata.
    expect(daysOverdue("2026-11-10", new Date("2026-11-11T03:00:00Z"), "America/New_York")).toBe(0);
    expect(daysOverdue("2026-11-10", new Date("2026-11-11T03:00:00Z"), "Asia/Kolkata")).toBe(1);
  });

  it("isn't thrown off by a DST change (New York, 1 Nov 2026)", () => {
    expect(daysOverdue("2026-10-31", new Date("2026-11-02T12:00:00Z"), "America/New_York")).toBe(2);
  });
});

describe("Outbox send times", () => {
  const WINDOW = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

  it("never shows a send time in the past or outside the window", () => {
    // Planned for last Friday; it's Saturday in New York, so the next opening is Monday 09:00.
    expect(
      effectiveSendAt(at("2026-11-20T15:00:00Z"), at("2026-11-21T15:00:00Z"), WINDOW, NY),
    ).toEqual(at("2026-11-23T14:00:00Z"));
  });

  it("keeps a future time that's inside the window", () => {
    const planned = at("2026-11-23T16:00:00Z");
    expect(effectiveSendAt(planned, at("2026-11-21T15:00:00Z"), WINDOW, NY)).toEqual(planned);
  });

  it("reads a picked time in the client's zone, across a DST change", () => {
    // 2 Nov 2026 is the Monday after clocks went back: 10:00 New York is 15:00Z, not 14:00Z.
    expect(rescheduledSendAt("2026-11-02T10:00", at("2026-10-30T12:00:00Z"), WINDOW, NY)).toEqual(
      at("2026-11-02T15:00:00Z"),
    );
  });

  it("moves a picked time outside the window to the next opening", () => {
    expect(rescheduledSendAt("2026-11-21T10:00", at("2026-11-20T12:00:00Z"), WINDOW, NY)).toEqual(
      at("2026-11-23T14:00:00Z"),
    );
  });

  it("refuses a picked time in the past, or that isn't real", () => {
    const now = at("2026-11-20T15:00:00Z");
    expect(rescheduledSendAt("2026-11-20T09:59", now, WINDOW, NY)).toBeUndefined();
    expect(rescheduledSendAt("2026-13-40T10:00", now, WINDOW, NY)).toBeUndefined();
  });

  it("gives an instant back as the input's value in the client's zone", () => {
    expect(localTimeInput(at("2026-11-23T14:00:00Z"), NY)).toBe("2026-11-23T09:00");
  });
});
