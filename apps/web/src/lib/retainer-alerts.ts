import { formatMoney } from "./format";

// What the freelancer is told when something happens to a retainer, on Telegram and as a dashboard
// flag. Built only from the database. Pure: safe in client components.

export type AlertKind =
  | "payment_failed"
  | "suspended"
  | "cancelled"
  | "recovered"
  | "reactivated"
  | "paid_twice"
  | "activated_after_cancel";

export type AlertFacts = {
  name: string;
  clientName: string;
  amountCents: number;
  currency: string;
};

export const alertText = (kind: AlertKind, facts: AlertFacts): string => {
  const what = `${facts.name} (${facts.clientName})`;
  const amount = formatMoney(facts.amountCents, facts.currency);
  switch (kind) {
    case "payment_failed":
      return `Auto-pay failed for ${what}, ${amount}. It's being paused in PayPal so the client can't be charged again, and then an invoice for this charge is made. Its reminders wait for your approval as usual, and auto-pay comes back on once it's paid.`;
    case "suspended":
      return `PayPal suspended auto-pay for ${what}, so no more charges will be made. Talk to the client, or cancel the retainer.`;
    case "cancelled":
      return `Auto-pay for ${what} was cancelled, so no more charges will be made. Any invoice already open stays open.`;
    case "recovered":
      return `PayPal's retry collected ${amount} for ${what}. No invoice is owed for that charge, any made is being cancelled with its reminders stopped, and auto-pay is running again.`;
    case "reactivated":
      return `The invoice for the failed charge on ${what} is paid, so auto-pay is back on. Any charge date that passed during the pause wasn't billed: check whether that's owed.`;
    case "paid_twice":
      return `${what} may have paid ${amount} twice: a PayPal charge arrived that was already under way, and the invoice for the same charge has money on it. Check both in PayPal, and refund one if so.`;
    case "activated_after_cancel":
      return `The client approved auto-pay for ${what} after you cancelled it. The subscription is being cancelled in PayPal. Check that no charge was made.`;
  }
};
