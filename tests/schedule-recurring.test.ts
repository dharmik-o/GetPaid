import { describe, expect, it } from "vitest";
import {
  maintenanceNextDue,
  maintenanceNoticeDue,
  maintenanceOccurrences,
  retainerCycleOn,
  retainerCyclesBetween,
  retainerDueDate,
  retainerTotalCycles,
} from "@/lib/schedule";

// Recurring dates: retainer charges, and maintenance due dates and notices.

const MONTHLY = { startsOn: "2026-01-31", endsOn: null, unit: "month", count: 1 } as const;
const FORTNIGHT = { startsOn: "2026-11-02", endsOn: null, unit: "week", count: 2 } as const;

describe("retainer cycles", () => {
  it("counts from the start date each time, so a short month doesn't shift later charges", () => {
    expect(retainerCyclesBetween(MONTHLY, "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("repeats every N weeks", () => {
    expect(retainerCyclesBetween(FORTNIGHT, "2026-11-03", "2026-12-01")).toEqual([
      "2026-11-16",
      "2026-11-30",
    ]);
  });

  it("stops at the end date", () => {
    const ending = { ...FORTNIGHT, endsOn: "2026-11-16" };
    expect(retainerCyclesBetween(ending, "2026-11-01", "2027-01-01")).toEqual([
      "2026-11-02",
      "2026-11-16",
    ]);
  });

  it("finds the charge a date falls in", () => {
    expect(retainerCycleOn(FORTNIGHT, "2026-11-20")).toBe("2026-11-16");
    expect(retainerCycleOn(FORTNIGHT, "2026-11-16")).toBe("2026-11-16");
    expect(retainerCycleOn(FORTNIGHT, "2026-11-01")).toBeUndefined();
  });

  it("gives PayPal 0 cycles for until cancelled, and the exact count with an end date", () => {
    expect(retainerTotalCycles(MONTHLY)).toBe(0);
    expect(retainerTotalCycles({ ...MONTHLY, endsOn: "2026-04-30" })).toBe(4);
    expect(retainerTotalCycles({ ...MONTHLY, endsOn: "2026-04-29" })).toBe(3);
  });

  it("works out the due date from the terms; a fixed date can't repeat, so it's the charge date", () => {
    expect(retainerDueDate({ kind: "net", days: 14 }, "2026-11-02")).toBe("2026-11-16");
    expect(retainerDueDate({ kind: "on_receipt" }, "2026-11-02")).toBe("2026-11-02");
    expect(retainerDueDate({ kind: "date", date: "2020-01-01" }, "2026-11-02")).toBe("2026-11-02");
  });
});

describe("maintenance next due date", () => {
  const task = { scheduledDue: "2026-05-15", repeatMonths: 6 };

  it("counts from the date it was done", () => {
    expect(maintenanceNextDue({ ...task, repeatFrom: "done", doneOn: "2026-05-20" })).toBe(
      "2026-11-20",
    );
  });

  it("counts from the original date", () => {
    expect(maintenanceNextDue({ ...task, repeatFrom: "scheduled", doneOn: "2026-05-20" })).toBe(
      "2026-11-15",
    );
  });

  it("moves on until it's in the future when done very late", () => {
    expect(maintenanceNextDue({ ...task, repeatFrom: "scheduled", doneOn: "2027-06-01" })).toBe(
      "2027-11-15",
    );
  });

  it("lists each repeat inside a period", () => {
    expect(maintenanceOccurrences("2026-11-30", 1, "2026-11-01", "2027-02-01")).toEqual([
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
    ]);
  });

  it("leaves out dates before the period, and includes an overdue job once", () => {
    expect(maintenanceOccurrences("2026-01-15", 6, "2026-11-01", "2027-02-01")).toEqual([
      "2026-01-15",
    ]);
  });
});

describe("maintenance notices", () => {
  const base = {
    nextDue: "2026-12-15",
    leadDays: [14, 1],
    snoozedUntil: null,
    lastNoticeOn: null,
    timeZone: "UTC",
  };
  const at = (iso: string) => new Date(iso);

  it("isn't due before the first lead day", () => {
    expect(maintenanceNoticeDue({ ...base, now: at("2026-11-30T12:00:00Z") })).toBe(false);
  });

  it("is due on the lead day, from 09:00 in the freelancer's zone", () => {
    expect(maintenanceNoticeDue({ ...base, now: at("2026-12-01T08:59:00Z") })).toBe(false);
    expect(maintenanceNoticeDue({ ...base, now: at("2026-12-01T09:00:00Z") })).toBe(true);
    expect(
      maintenanceNoticeDue({
        ...base,
        timeZone: "Asia/Kolkata",
        now: at("2026-12-01T03:30:00Z"),
      }),
    ).toBe(true);
  });

  it("sends once per lead day", () => {
    const noticed = { ...base, lastNoticeOn: "2026-12-01" };
    expect(maintenanceNoticeDue({ ...noticed, now: at("2026-12-10T12:00:00Z") })).toBe(false);
    expect(maintenanceNoticeDue({ ...noticed, now: at("2026-12-14T12:00:00Z") })).toBe(true);
  });

  it("sends one notice, not two, when it catches up past both lead days", () => {
    const late = { ...base, lastNoticeOn: "2026-12-14" };
    expect(maintenanceNoticeDue({ ...late, now: at("2026-12-20T12:00:00Z") })).toBe(false);
  });

  it("waits out a snooze, then reminds again", () => {
    const snoozed = { ...base, snoozedUntil: "2026-12-05", lastNoticeOn: "2026-12-01" };
    expect(maintenanceNoticeDue({ ...snoozed, now: at("2026-12-04T12:00:00Z") })).toBe(false);
    expect(maintenanceNoticeDue({ ...snoozed, now: at("2026-12-05T12:00:00Z") })).toBe(true);
  });
});
