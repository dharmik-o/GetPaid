import { z } from "zod";

// Which paid items have already had their stamp, in this browser. Pure and browser-only: nothing here
// reaches the server, and it only decides whether an animation plays.

export const PAID_STAMPS_KEY = "getpaid.paid-stamps-seen";

type Store = Pick<Storage, "getItem" | "setItem">;

const seenSchema = z.array(z.string());

const parseSeen = (stored: string | null): string[] => {
  if (stored === null) return [];
  try {
    return seenSchema.safeParse(JSON.parse(stored)).data ?? [];
  } catch {
    return [];
  }
};

/**
 * True the first time an ID is claimed, and false after that. Also false if storage is blocked or
 * full: with nowhere to remember it, the stamp would replay on every load.
 */
export const claimPaidStamp = (id: string, store?: Store): boolean => {
  try {
    const storage = store ?? window.localStorage;
    const seen = parseSeen(storage.getItem(PAID_STAMPS_KEY));
    if (seen.includes(id)) return false;
    storage.setItem(PAID_STAMPS_KEY, JSON.stringify([...seen, id]));
    return true;
  } catch {
    return false;
  }
};

export const invoiceStampId = (invoiceNumber: string): string => `invoice:${invoiceNumber}`;

export const holdStampId = (holdId: string): string => `hold:${holdId}`;
