import { z } from "zod";

// The draft saved on a reminder (reminders.draft): the email, plus how it was made, for the
// Outbox and Telegram cards. Pure: safe in client components.

export const storedDraftSchema = z.strictObject({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  kind: z.enum([
    "courtesy",
    "tier1",
    "tier2",
    "tier3",
    "maintenance",
    "auto_pay_approval",
    "hold_approval",
    "agreement_request",
    "agreement_signed_copy",
  ]),
  /** "model": an AI answer that passed every check; "template": the fixed fallback. */
  via: z.enum(["model", "template"]),
  model: z.string().nullable(),
  isLocal: z.boolean().nullable(),
  /** What a Tier 3 notice cites: the contract clause, a law from legal/statutes.json, or nothing. */
  citation: z.enum(["contract", "statute"]).nullable(),
  lawId: z.string().nullable(),
  /** Tier 3 drafts show a "not legal advice" note to the freelancer. */
  notLegalAdvice: z.boolean(),
  draftedAt: z.iso.datetime(),
  /** Set when the freelancer changed the wording; `via` and `model` still say how it began. */
  editedAt: z.iso.datetime().optional(),
});

export type StoredDraft = z.infer<typeof storedDraftSchema>;
