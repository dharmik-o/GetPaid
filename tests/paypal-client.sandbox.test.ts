import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadPaypalEnv } from "@/lib/env";
import { paypalFromEnv, type InvoiceDraft } from "@/lib/paypal";

// Real PayPal SANDBOX calls (`npm run test:paypal:sandbox`). PayPal sends no emails: every
// send and cancel uses send_to_recipient: false, and the recipient is a reserved test domain.

const paypal = paypalFromEnv();
const leftovers: string[] = [];

const draft = (overrides: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  requestId: randomUUID(),
  // App invoices are numbered FPR-…; test invoices get their own prefix so the two never collide.
  invoiceNumber: `TEST-${randomUUID().slice(0, 18)}`,
  currency: "USD",
  amountCents: 90000,
  partialPayment: null,
  dueDate: null,
  itemName: "Design (sandbox test)",
  itemDescription: "Website redesign",
  recipient: { email: "sandbox-client@example.com", name: "Sandbox Test Client" },
  ...overrides,
});

const inTwoWeeks = (): string => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

afterAll(async () => {
  for (const id of leftovers) await paypal.deleteInvoice(id).catch(() => undefined);
});

describe("PayPal sandbox: invoices", () => {
  it("a retry (same PayPal-Request-Id and invoice number) returns the same invoice", async () => {
    const input = draft();
    const first = await paypal.createInvoice(input);
    leftovers.push(first.id);
    const retry = await paypal.createInvoice(input);
    expect(retry.id).toBe(first.id);
    const other = await paypal.createInvoice(draft());
    leftovers.push(other.id);
    expect(other.id).not.toBe(first.id);
  });

  it("creates, sends and cancels an invoice with a due date", async () => {
    const { id } = await paypal.createInvoice(draft({ dueDate: inTwoWeeks() }));
    expect((await paypal.getInvoice(id)).status).toBe("DRAFT");

    await paypal.sendInvoice(id);
    const sent = await paypal.getInvoice(id);
    expect(["SENT", "UNPAID"]).toContain(sent.status);
    expect(sent.amountCents).toBe(90000);
    expect(sent.paidCents).toBe(0);
    expect(sent.payerViewUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    await paypal.cancelInvoice(id);
    expect((await paypal.getInvoice(id)).status).toBe("CANCELLED");
  });

  it("deletes a draft that was never sent", async () => {
    const { id } = await paypal.createInvoice(draft());
    await paypal.deleteInvoice(id);
    await expect(paypal.getInvoice(id)).rejects.toThrow(/PayPal rejected read invoice/);
  });

  it("handles a zero-decimal currency", async () => {
    const { id } = await paypal.createInvoice(draft({ currency: "JPY", amountCents: 150000 }));
    leftovers.push(id);
    expect((await paypal.getInvoice(id)).amountCents).toBe(150000);
  });

  // Needs a sandbox business account in a country where PayPal offers partial payments
  // (see docs/NEEDS_YOU.md). Deposits and installments depend on it.
  it("creates a deposit with partial payment and a minimum amount due", async () => {
    const { id } = await paypal.createInvoice(
      draft({ dueDate: inTwoWeeks(), partialPayment: { minimumDueCents: 30000 } }),
    );
    leftovers.push(id);
    expect((await paypal.getInvoice(id)).status).toBe("DRAFT");
  });
});

describe("PayPal sandbox: webhook verification", () => {
  it("answers FAILURE (not an error) for a forged delivery", async () => {
    const webhookId = loadPaypalEnv().PAYPAL_WEBHOOK_ID;
    expect(webhookId, "set PAYPAL_WEBHOOK_ID in the local env file").toBeTruthy();
    const forged = `{"id":"WH-FORGED-1","event_type":"INVOICING.INVOICE.PAID","resource":{"id":"INV2-FORGED"}}`;
    const verified = await paypal.verifyWebhook(
      {
        auth_algo: "SHA256withRSA",
        cert_url:
          "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
        transmission_id: randomUUID(),
        transmission_sig: "Zm9yZ2Vk",
        transmission_time: new Date().toISOString(),
      },
      forged,
      webhookId ?? "",
    );
    expect(verified).toBe(false);
  });
});
