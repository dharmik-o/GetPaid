import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPaypalClient,
  PAYPAL_SANDBOX_BASE,
  PaypalError,
  type InvoiceDraft,
  type PaypalClient,
} from "@/lib/paypal";
import { createFakePaypal, type FakePaypal } from "./mocks/paypal";

const server = setupServer();
let fake: FakePaypal;
let client: PaypalClient;

const SECRET = "client-secret-not-for-logs";

const DRAFT: InvoiceDraft = {
  requestId: "6f1c6c58-6d1e-4f5c-9a43-1b1e2c3d4e5f",
  invoiceNumber: "FPR-000042",
  currency: "USD",
  amountCents: 90000,
  partialPayment: { minimumDueCents: 30000 },
  dueDate: "2026-12-08",
  itemName: "Design",
  itemDescription: "Website redesign",
  recipient: { email: "client-a@example.test", name: "Client A" },
};

beforeAll(() => { server.listen({ onUnhandledFrame: "error" }); });
beforeEach(() => {
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  client = createPaypalClient({ clientId: "client-id", clientSecret: SECRET });
});
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

describe("createInvoice", () => {
  it("creates a draft with partial payment on and the deposit's minimum due", async () => {
    const { id } = await client.createInvoice(DRAFT);
    const body = fake.invoices.get(id)?.body;
    expect(body).toEqual({
      detail: {
        currency_code: "USD",
        invoice_number: "FPR-000042",
        payment_term: { due_date: "2026-12-08" },
      },
      primary_recipients: [
        { billing_info: { email_address: "client-a@example.test", business_name: "Client A" } },
      ],
      items: [
        {
          name: "Design",
          description: "Website redesign",
          quantity: "1",
          unit_amount: { currency_code: "USD", value: "900.00" },
        },
      ],
      configuration: {
        allow_tip: false,
        partial_payment: {
          allow_partial_payment: true,
          minimum_amount_due: { currency_code: "USD", value: "300.00" },
        },
      },
    });
  });

  it("allows any partial payment when there is no minimum, and uses due-on-receipt terms", async () => {
    const { id } = await client.createInvoice({
      ...DRAFT,
      partialPayment: { minimumDueCents: null },
      dueDate: null,
    });
    const body = fake.invoices.get(id)?.body as {
      detail: unknown;
      configuration: unknown;
    };
    expect(body.detail).toEqual({
      currency_code: "USD",
      invoice_number: "FPR-000042",
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    });
    expect(body.configuration).toEqual({
      allow_tip: false,
      partial_payment: { allow_partial_payment: true },
    });
  });

  it("leaves partial payments off only when asked", async () => {
    const { id } = await client.createInvoice({ ...DRAFT, partialPayment: null });
    expect(fake.invoices.get(id)?.body.configuration).toEqual({ allow_tip: false });
  });

  it("sends the PayPal-Request-Id on create", async () => {
    await client.createInvoice(DRAFT);
    const creates = fake.calls.filter((c) => c.path === "/v2/invoicing/invoices");
    expect(creates.map((c) => c.requestId)).toEqual([DRAFT.requestId]);
  });

  it("returns the existing invoice on a retry with the same invoice number", async () => {
    // PayPal ignores PayPal-Request-Id on invoices but refuses a repeated invoice number.
    const first = await client.createInvoice(DRAFT);
    const retry = await client.createInvoice({ ...DRAFT, requestId: "another-request-id" });
    expect(retry.id).toBe(first.id);
    expect(fake.invoices.size).toBe(1);
  });

  it("matches the invoice number exactly when searching", async () => {
    await client.createInvoice({ ...DRAFT, invoiceNumber: "FPR-0000420" });
    const first = await client.createInvoice(DRAFT);
    expect((await client.createInvoice(DRAFT)).id).toBe(first.id);
  });

  it("tries once more when the network fails before PayPal answers", async () => {
    let failed = false;
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices`, () => {
        if (failed) return undefined;
        failed = true;
        return HttpResponse.error();
      }),
    );
    const { id } = await client.createInvoice(DRAFT);
    expect(fake.invoices.has(id)).toBe(true);
  });

  it("reads the id from a short (link-only) create response", async () => {
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices`, () =>
        HttpResponse.json(
          {
            rel: "self",
            href: `${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/INV2-LINK-ONLY`,
            method: "GET",
          },
          { status: 201 },
        ),
      ),
    );
    expect(await client.createInvoice(DRAFT)).toEqual({ id: "INV2-LINK-ONLY" });
  });
});

describe("access token", () => {
  it("is fetched once and reused", async () => {
    await client.createInvoice(DRAFT);
    await client.getInvoice((await client.createInvoice(DRAFT)).id);
    expect(fake.tokensIssued).toBe(1);
  });

  it("is fetched again once when PayPal answers 401", async () => {
    const { id } = await client.createInvoice(DRAFT);
    let rejected = false;
    server.use(
      http.get(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id`, () => {
        if (rejected) return undefined;
        rejected = true;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    expect((await client.getInvoice(id)).status).toBe("DRAFT");
    expect(fake.tokensIssued).toBe(2);
  });
});

describe("sendInvoice and getInvoice", () => {
  it("sends without PayPal emailing anyone, then reports the payer link and amounts", async () => {
    let sendBody: unknown;
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id/send`, async ({ request }) => {
        sendBody = await request.clone().json();
        return undefined;
      }),
    );
    const { id } = await client.createInvoice(DRAFT);
    await client.sendInvoice(id);
    expect(sendBody).toEqual({ send_to_invoicer: false, send_to_recipient: false });
    fake.pay(id, "300.00", "PARTIALLY_PAID");
    expect(await client.getInvoice(id)).toEqual({
      id,
      status: "PARTIALLY_PAID",
      currency: "USD",
      amountCents: 90000,
      paidCents: 30000,
      payerViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${id}`,
    });
  });
});

describe("cancelInvoice and deleteInvoice", () => {
  it("cancels a sent invoice without emailing anyone", async () => {
    const { id } = await client.createInvoice(DRAFT);
    await client.sendInvoice(id);
    await client.cancelInvoice(id);
    expect(fake.invoices.get(id)?.status).toBe("CANCELLED");
  });

  it("deletes a draft", async () => {
    const { id } = await client.createInvoice(DRAFT);
    await client.deleteInvoice(id);
    expect(fake.invoices.has(id)).toBe(false);
  });
});

describe("errors", () => {
  it("throw a PaypalError with the status, issue and debug id, never the secret", async () => {
    const { id } = await client.createInvoice(DRAFT);
    const error = await client.cancelInvoice(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaypalError);
    const paypalError = error as PaypalError;
    expect(paypalError.status).toBe(422);
    expect(paypalError.issue).toBe("CANT_CANCEL");
    expect(paypalError.debugId).toBe("fake-debug");
    expect(paypalError.message).toMatch(/PayPal rejected cancel invoice/);
    expect(paypalError.message).not.toContain(SECRET);
  });

  it("explain a failed sign-in", async () => {
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, () =>
        HttpResponse.json({ error: "invalid_client" }, { status: 401 }),
      ),
    );
    await expect(client.createInvoice(DRAFT)).rejects.toThrow(
      /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/,
    );
  });

  it("explain a response PayPal shouldn't send", async () => {
    server.use(
      http.get(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id`, () =>
        HttpResponse.json({ unexpected: true }),
      ),
    );
    await expect(client.getInvoice("INV2-X")).rejects.toThrow(/unexpected response/);
  });
});

describe("sandbox only", () => {
  it("calls the sandbox host", () => {
    expect(PAYPAL_SANDBOX_BASE).toBe("https://api-m.sandbox.paypal.com");
  });
});
