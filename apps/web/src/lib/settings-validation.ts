import { toFieldIssues, type FieldIssue } from "./field-issues";
import { computeDueDate } from "./schedule";
import {
  DEFAULT_SETTINGS,
  settingsOverrideSchema,
  type PaymentTerms,
  type ScheduleSettings,
  type SettingsOverride,
} from "./settings";

export type { FieldIssue };

export type SettingsContext = {
  /** The merged settings of the layers above, for settings this layer inherits. */
  parent?: ScheduleSettings;
  /** Delivery deadline of the project or milestone (`YYYY-MM-DD`). */
  deadline?: string;
  /** When the invoice is (or will be) issued, to work out a Net due date. */
  issuedOn?: string;
  /** Set on project and milestone layers: whether the contract has a late-fee clause. */
  contractHasLateFee?: boolean;
};

export type SettingsValidation =
  | { ok: true; settings: SettingsOverride; warnings: FieldIssue[] }
  | { ok: false; errors: FieldIssue[]; warnings: FieldIssue[] };

const lateFeeIssues = (settings: SettingsOverride, context: SettingsContext): FieldIssue[] =>
  context.contractHasLateFee === false && settings.lateFee
    ? [
        {
          field: "lateFee",
          message: "needs a late-fee clause in the contract. Add the clause to the project first.",
        },
      ]
    : [];

/** The terms this layer ends up with, read even when other fields are invalid. */
const effectiveTerms = (raw: unknown, context: SettingsContext): PaymentTerms | undefined => {
  if (raw && typeof raw === "object" && "paymentTerms" in raw) {
    const parsed = settingsOverrideSchema.shape.paymentTerms.safeParse(raw.paymentTerms);
    return parsed.success ? parsed.data : undefined;
  }
  return (context.parent ?? DEFAULT_SETTINGS).paymentTerms;
};

const knownDueDate = (terms: PaymentTerms, issuedOn: string | undefined): string | undefined => {
  if (terms.kind === "date") return terms.date;
  return issuedOn ? computeDueDate(terms, issuedOn) : undefined;
};

/** Warn, don't block, when the payment is due before the work is. */
const deadlineWarnings = (raw: unknown, context: SettingsContext): FieldIssue[] => {
  const terms = effectiveTerms(raw, context);
  if (!terms || !context.deadline) return [];
  const dueDate = knownDueDate(terms, context.issuedOn);
  if (!dueDate || dueDate >= context.deadline) return [];
  return [
    {
      field: "paymentTerms",
      message:
        `The payment due date (${dueDate}) is before the delivery deadline (${context.deadline}). ` +
        "You can still save; check this is what you agreed with the client.",
    },
  ];
};

/** Checks one layer's settings from a form or API call: field-level errors, plus warnings. */
export const validateSettings = (
  raw: unknown,
  context: SettingsContext = {},
): SettingsValidation => {
  const warnings = deadlineWarnings(raw, context);
  const parsed = settingsOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: toFieldIssues(parsed.error), warnings };
  }
  const errors = lateFeeIssues(parsed.data, context);
  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, settings: parsed.data, warnings };
};
