import type { ScheduleSettings, SettingsOverride } from "./settings";

// Pure helpers behind ScheduleForm. Safe in client components.

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** This layer's settings without one key: that setting is inherited again. */
export const withoutOverride = (
  value: SettingsOverride,
  key: keyof ScheduleSettings,
): SettingsOverride =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

/** Sets one setting on this layer; drops it when it equals what the layers above give. */
export const setOverride = <K extends keyof ScheduleSettings>(
  value: SettingsOverride,
  inherited: ScheduleSettings,
  key: K,
  next: ScheduleSettings[K],
): SettingsOverride =>
  same(next, inherited[key]) ? withoutOverride(value, key) : { ...value, [key]: next };

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** "1.5" (% per month) to basis points (150), with string maths only. NaN when unreadable. */
export const parsePercent = (text: string): number => {
  const match = PERCENT.exec(text.trim());
  if (!match) return Number.NaN;
  const [, whole = "0", fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

/** Basis points (150) as a typed percentage ("1.5"). */
export const formatPercent = (basisPoints: number): string => {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${String(whole)}.${fraction}` : String(whole);
};

/** Dates typed as a list, split on commas, spaces or new lines. */
export const parseDateList = (text: string): string[] =>
  text.split(/[\s,]+/).filter((part) => part.length > 0);
