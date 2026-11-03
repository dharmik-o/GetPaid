import { describe, expect, it } from "vitest";
import { syncedStatus } from "@/lib/paypal-webhook";

describe("syncedStatus", () => {
  it.each([
    ["sent", "PAID", "paid"],
    ["sent", "MARKED_AS_PAID", "paid"],
    ["sent", "PARTIALLY_PAID", "partially_paid"],
    ["partially_paid", "PAID", "paid"],
    ["paid", "REFUNDED", "refunded"],
    ["paid", "PARTIALLY_REFUNDED", "refunded"],
    ["sent", "CANCELLED", "cancelled"],
    ["sent", "UNPAID", "sent"],
    ["sent", "PAYMENT_PENDING", "sent"],
    ["partially_paid", "SOMETHING_NEW", "partially_paid"],
  ] as const)("%s + PayPal %s is %s", (current, paypal, expected) => {
    expect(syncedStatus(current, paypal)).toBe(expected);
  });

  it("keeps a dispute open through payment updates, but not a refund", () => {
    expect(syncedStatus("disputed", "PAID")).toBe("disputed");
    expect(syncedStatus("disputed", "PARTIALLY_PAID")).toBe("disputed");
    expect(syncedStatus("disputed", "REFUNDED")).toBe("refunded");
  });
});
