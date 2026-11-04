import type { Tier } from "./schedule";

// The facts a draft is written from. Every value comes from the database and is already
// formatted (money by the one money formatter, dates as "18 Nov 2026"), so a model only ever
// copies them. Pure: safe in client components.

/** What a Tier 3 notice may cite: the contract's own clause or an entry in legal/statutes.json. */
export type Citation =
  { kind: "contract"; text: string } | { kind: "statute"; lawId: string; text: string };

export type ReminderFacts = {
  freelancerName: string;
  clientName: string;
  projectTitle: string;
  milestoneName: string;
  deliverable: string | null;
  invoiceNumber: string;
  /** What's left to pay on this invoice, e.g. "USD 1,500.00". */
  amountDue: string;
  /** "31 Oct 2026". */
  dueDate: string;
  /** Calendar days after the due date in the client's time zone; negative before it. */
  daysOverdue: number;
  /** "Net 14", "Due on receipt" or "Due by 18 Nov 2026". */
  paymentTerms: string;
  contractTerms: string | null;
  /** "Installment 2 of 3", or null for a plain invoice. */
  installment: string | null;
  payLink: string;
  /** Tier 3 only: the one reference it may make, or null for a plain final notice. */
  citation: Citation | null;
};

export type MaintenanceFacts = {
  freelancerName: string;
  clientName: string;
  projectTitle: string;
  task: string;
  type: "maintenance" | "renewal";
  dueDate: string;
  /** "USD 200.00", or null when the freelancer set no estimate. */
  estimatedCost: string | null;
};

/** Asking a client to approve auto-pay. */
export type AutoPayFacts = {
  freelancerName: string;
  clientName: string;
  retainerName: string;
  /** "USD 200.00". */
  amount: string;
  /** "every month". */
  repeat: string;
  firstCharge: string;
  /** Null means until cancelled. */
  lastCharge: string | null;
  /** PayPal's approval page: the email's only link. */
  approvalLink: string;
};

/** Asking a client to authorize a milestone hold. */
export type HoldFacts = {
  freelancerName: string;
  clientName: string;
  projectTitle: string;
  milestoneName: string;
  /** "USD 1,500.00". */
  amount: string;
  /** PayPal's approval page: the email's only link. */
  approvalLink: string;
};

export type DraftRequest =
  | { kind: Tier; facts: ReminderFacts }
  | { kind: "maintenance"; facts: MaintenanceFacts }
  | { kind: "auto_pay_approval"; facts: AutoPayFacts }
  | { kind: "hold_approval"; facts: HoldFacts };

export type DraftKind = DraftRequest["kind"];
