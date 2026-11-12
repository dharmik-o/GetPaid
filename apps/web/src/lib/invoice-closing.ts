// Words and choices for closing an invoice by hand: a payment received outside PayPal, or a
// cancellation. No server code here, so the forms and the routes share one list.

export const PAYMENT_METHODS = ["bank_transfer", "upi", "cash", "cheque", "wise", "other"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  bank_transfer: "Bank transfer",
  upi: "UPI",
  cash: "Cash",
  cheque: "Cheque",
  wise: "Wise/other app",
  other: "Other",
};

export const CANCEL_REASONS = ["agreed_not_to_charge", "writing_off", "mistake", "other"] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_REASON_LABELS: Readonly<Record<CancelReason, string>> = {
  agreed_not_to_charge: "Agreed not to charge",
  writing_off: "Client won't pay — writing it off",
  mistake: "Mistake",
  other: "Other",
};

/** Words for a method stored on a payment, or for one nobody recognises. */
export const methodLabel = (method: string): string =>
  (METHOD_LABELS as Record<string, string | undefined>)[method] ?? "Other";

export const cancelReasonLabel = (reason: string): string | undefined =>
  (CANCEL_REASON_LABELS as Record<string, string | undefined>)[reason];

/** Invoice statuses where money can still be recorded: sent, with something owed. */
export const RECORDABLE_STATUSES: readonly string[] = ["sent", "partially_paid"];
