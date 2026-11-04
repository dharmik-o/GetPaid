import { formatMoney } from "./format";

// What the freelancer is told when something happens to a retainer, on Telegram and as a dashboard
// flag. Built only from the database. Pure: safe in client components.

export type AlertKind =
  | "payment_failed"
  | "suspended"
  | "cancelled"
  | "recovered"
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
      return `Auto-pay failed for ${what}, ${amount}. PayPal will retry. An invoice for this cycle is ready, and its reminders wait for your approval as usual.`;
    case "suspended":
      return `PayPal suspended auto-pay for ${what}, so no more charges will be made. Talk to the client, or cancel the retainer.`;
    case "cancelled":
      return `Auto-pay for ${what} was cancelled, so no more charges will be made. Any invoice already open stays open.`;
    case "recovered":
      return `PayPal's retry collected ${amount} for ${what}. The invoice for that charge is no longer owed, so it's being cancelled and its reminders are stopped.`;
    case "paid_twice":
      return `${what} may have paid ${amount} twice: PayPal's retry succeeded, and the invoice for the same charge has money on it. Check both in PayPal, and refund one if so.`;
    case "activated_after_cancel":
      return `The client approved auto-pay for ${what} after you cancelled it. The subscription is being cancelled in PayPal. Check that no charge was made.`;
  }
};
