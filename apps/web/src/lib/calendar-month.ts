import { addCalendarDays, startOfWeekDate } from "./schedule";

// Pure helpers for the month view: which month, which 6 weeks to draw, and the month either side.

export const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The month named by `?month=`, or the month of `today` when it's missing or not a real month. */
export const monthOrToday = (param: string | undefined, today: string): string =>
  param !== undefined && MONTH_PARAM.test(param) ? param : today.slice(0, 7);

export const shiftMonth = (month: string, by: number): string => {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + by;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
};

/** Six weeks of ISO dates, Monday first, that cover the whole month. */
export const monthGrid = (month: string): string[][] => {
  const first = startOfWeekDate(`${month}-01`);
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addCalendarDays(first, week * 7 + day)),
  );
};
