import { z } from "zod";

// Schedule settings, layered: account, then client, then project, then milestone.
// Each layer stores only the settings it overrides; the most specific layer wins.

const isoDate = z.iso.date({ error: "must be a date like 2026-12-31" });

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const clockTime = z.string().regex(CLOCK_TIME, "must be a 24-hour time like 09:00");

const paymentTermsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("on_receipt") }),
  z.strictObject({
    kind: z.literal("net"),
    days: z.literal([7, 14, 30, 45, 60], { error: "must be Net 7, 14, 30, 45 or 60" }),
  }),
  z.strictObject({ kind: z.literal("date"), date: isoDate }),
]);

const intervalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("every"),
    days: z.int().min(1, "must be at least 1 day").max(90, "must be 90 days or fewer"),
  }),
  z.strictObject({
    kind: z.literal("dates"),
    dates: z.array(isoDate).min(1, "needs at least one date"),
  }),
]);

const tierStart = z.int().min(1, "must be 1 day overdue or later").max(365, "must be 365 or fewer");

/** Each tier must start later than the one before it. */
const tierBoundariesSchema = z
  .strictObject({ tier1: tierStart, tier2: tierStart, tier3: tierStart })
  .superRefine(({ tier1, tier2, tier3 }, ctx) => {
    if (tier2 <= tier1) {
      ctx.addIssue({
        code: "custom",
        path: ["tier2"],
        message: `must start after Tier 1 (day ${String(tier1)})`,
      });
    }
    if (tier3 <= tier2) {
      ctx.addIssue({
        code: "custom",
        path: ["tier3"],
        message: `must start after Tier 2 (day ${String(tier2)})`,
      });
    }
  });

/** ISO weekdays: 1 = Monday ... 7 = Sunday, in the client's time zone. */
const sendWindowSchema = z
  .strictObject({
    days: z
      .array(
        z
          .int()
          .min(1, "must be 1 (Monday) to 7 (Sunday)")
          .max(7, "must be 1 (Monday) to 7 (Sunday)"),
      )
      .min(1, "needs at least one day")
      .refine((days) => new Set(days).size === days.length, "lists a day more than once"),
    start: clockTime,
    end: clockTime,
  })
  .superRefine(({ start, end }, ctx) => {
    // Zero-padded HH:MM strings compare in time order. Windows can't wrap past midnight.
    if (CLOCK_TIME.test(start) && CLOCK_TIME.test(end) && end <= start) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: `must be after the start time (${start})`,
      });
    }
  });

const lateFeeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("percent_per_month"),
    basisPoints: z.int().min(1, "must be more than 0%").max(10000, "must be 100% or less"),
  }),
  z.strictObject({
    kind: z.literal("flat"),
    amountCents: z.int("must be whole cents").min(1, "must be more than 0"),
  }),
]);

const settingsShape = {
  paymentTerms: paymentTermsSchema,
  /** Courtesy note this many days before the due date; null = off. */
  preDueDays: z
    .int()
    .min(1, "must be at least 1 day")
    .max(30, "must be 30 days or fewer")
    .nullable(),
  graceDays: z.int().min(0, "can't be negative").max(14, "must be 14 days or fewer"),
  interval: intervalSchema,
  maxPerTier: z.int().min(1, "must be at least 1").max(5, "must be 5 or fewer"),
  tierBoundaries: tierBoundariesSchema,
  sendWindow: sendWindowSchema,
  /** Only if the contract has a late-fee clause; null = none. */
  lateFee: lateFeeSchema.nullable(),
  /** Tier 3 always needs approval, whatever this says. */
  approvalMode: z.enum(["approve_all", "auto_send_tier1"]),
  paused: z.boolean(),
  /** A date in the client's time zone; null = not snoozed. */
  snoozeUntil: isoDate.nullable(),
};

export const scheduleSettingsSchema = z.strictObject(settingsShape);

/** What one layer may store: any subset of the settings. */
export const settingsOverrideSchema = scheduleSettingsSchema.partial();

export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;
export type SettingsOverride = z.infer<typeof settingsOverrideSchema>;
export type PaymentTerms = ScheduleSettings["paymentTerms"];
export type ReminderInterval = ScheduleSettings["interval"];
export type TierBoundaries = ScheduleSettings["tierBoundaries"];
export type SendWindow = ScheduleSettings["sendWindow"];
export type LateFee = NonNullable<ScheduleSettings["lateFee"]>;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

/** The defaults from the spec's project setup table. */
export const DEFAULT_SETTINGS: Readonly<ScheduleSettings> = deepFreeze({
  paymentTerms: { kind: "net", days: 14 },
  preDueDays: 2,
  graceDays: 0,
  interval: { kind: "every", days: 3 },
  maxPerTier: 2,
  tierBoundaries: { tier1: 1, tier2: 8, tier3: 22 },
  sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  lateFee: null,
  approvalMode: "approve_all",
  paused: false,
  snoozeUntil: null,
});

export const SETTINGS_LAYERS = ["account", "client", "project", "milestone"] as const;
export type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

/** Raw `settings` jsonb per layer, as stored. Missing or null layers count as empty. */
export type SettingsLayers = Partial<Record<SettingsLayer, unknown>>;

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "(whole object)"} ${issue.message}`)
    .join("; ");

const parseLayer = (layer: SettingsLayer, raw: unknown): SettingsOverride => {
  const result = settingsOverrideSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  throw new Error(
    `The saved ${layer} settings are not valid: ${describeIssues(result.error)}. ` +
      `Fix them in the ${layer} settings and save again.`,
  );
};

/** Drops keys a JS caller set to undefined, so they inherit instead of erasing the layer above. */
const definedOnly = (override: SettingsOverride): SettingsOverride =>
  Object.fromEntries(
    Object.entries(override as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );

const latestDate = (dates: (string | null | undefined)[]): string | null =>
  dates.reduce<string | null>(
    (latest, date) => (date && (!latest || date > latest) ? date : latest),
    null,
  );

/**
 * The one place settings are merged. Every setting comes from the most specific layer that sets it;
 * grouped settings (terms, interval, tiers, send window, late fee) are replaced whole.
 * Pause and snooze are stops, not preferences: a pause on any layer pauses, and the latest snooze wins.
 */
export const mergeSettings = (layers: SettingsLayers): ScheduleSettings => {
  const overrides = SETTINGS_LAYERS.map((layer) => parseLayer(layer, layers[layer]));
  const merged = overrides.reduce<ScheduleSettings>(
    (current, override) => ({ ...current, ...definedOnly(override) }),
    structuredClone(DEFAULT_SETTINGS),
  );
  return {
    ...merged,
    paused: overrides.some((override) => override.paused === true),
    snoozeUntil: latestDate(overrides.map((override) => override.snoozeUntil)),
  };
};
