import { http, HttpResponse, type HttpHandler } from "msw";
import { PAYPAL_SANDBOX_BASE } from "@/lib/paypal";

// An in-memory PayPal sandbox for msw, matching what the real sandbox does: create ignores
// PayPal-Request-Id but refuses a second invoice with the same invoice number. It follows the
// invoice states the app relies on, and verifies webhook signatures: only events signed with
// VALID_SIGNATURE for FAKE_WEBHOOK_ID pass. No real network calls.

export const FAKE_TOKEN = "fake-access-token";
export const FAKE_WEBHOOK_ID = "WH-FAKE-0001";
export const VALID_SIGNATURE = "valid-signature";

export type FakeInvoice = {
  id: string;
  status: string;
  body: Record<string, unknown>;
  paidValue: string | null;
  refundedValue: string | null;
};

/** One request the app made, with its body text (empty when there is none). */
type Call = { method: string; path: string; requestId: string | null; body: string };

/** One call to verify-webhook-signature, with its raw request text. */
type Verification = { text: string; body: Record<string, unknown> };

const invoiceJson = (invoice: FakeInvoice) => {
  const detail = (invoice.body.detail ?? {}) as Record<string, unknown>;
  const items = (invoice.body.items ?? []) as { unit_amount: { value: string } }[];
  const currency = String(detail.currency_code);
  return {
    id: invoice.id,
    status: invoice.status,
    detail: {
      ...detail,
      metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${invoice.id}` },
    },
    amount: { currency_code: currency, value: items[0]?.unit_amount.value ?? "0.00" },
    ...(invoice.paidValue
      ? { payments: { paid_amount: { currency_code: currency, value: invoice.paidValue } } }
      : {}),
    ...(invoice.refundedValue
      ? { refunds: { refund_amount: { currency_code: currency, value: invoice.refundedValue } } }
      : {}),
  };
};

const invoiceNumberOf = (body: Record<string, unknown>): string => {
  const number = (body.detail as { invoice_number?: unknown } | undefined)?.invoice_number;
  return typeof number === "string" ? number : "";
};

const unprocessable = (issue: string) =>
  HttpResponse.json(
    { name: "UNPROCESSABLE_ENTITY", debug_id: "fake-debug", details: [{ issue }] },
    { status: 422 },
  );

export const createFakePaypal = () => {
  const invoices = new Map<string, FakeInvoice>();
  const calls: Call[] = [];
  const verifications: Verification[] = [];
  let tokensIssued = 0;
  let nextId = 1;

  const record = async (request: Request) => {
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      requestId: request.headers.get("paypal-request-id"),
      body: await request.clone().text(),
    });
  };

  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${FAKE_TOKEN}`;

  const withInvoice = async (
    request: Request,
    id: string | readonly string[] | undefined,
    act: (invoice: FakeInvoice) => Response | Promise<Response>,
  ) => {
    await record(request);
    if (!authorized(request)) return new HttpResponse(null, { status: 401 });
    const invoice = invoices.get(String(id));
    if (!invoice) {
      return HttpResponse.json({ name: "RESOURCE_NOT_FOUND", debug_id: "fake" }, { status: 404 });
    }
    return act(invoice);
  };

  const base = `${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices`;

  /** Creates a draft as PayPal would. Tests use it directly for "created, but the answer was lost". */
  const store = (body: Record<string, unknown>): FakeInvoice => {
    const id = `INV2-FAKE-${String(nextId++).padStart(4, "0")}`;
    const invoice: FakeInvoice = {
      id,
      status: "DRAFT",
      body,
      paidValue: null,
      refundedValue: null,
    };
    invoices.set(id, invoice);
    return invoice;
  };

  const handlers: HttpHandler[] = [
    http.post(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, async ({ request }) => {
      await record(request);
      tokensIssued += 1;
      return HttpResponse.json({
        access_token: FAKE_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),

    http.post(base, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const body = (await request.json()) as Record<string, unknown>;
      const number = invoiceNumberOf(body);
      if ([...invoices.values()].some((invoice) => invoiceNumberOf(invoice.body) === number)) {
        return unprocessable("DUPLICATE_INVOICE_NUMBER");
      }
      return HttpResponse.json(invoiceJson(store(body)), { status: 201 });
    }),

    http.post(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/search-invoices`, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { invoice_number: number } = (await request.json()) as { invoice_number?: string };
      // Like PayPal's search, a partial number matches too; the client must filter exactly.
      const items = [...invoices.values()]
        .filter((invoice) => number && invoiceNumberOf(invoice.body).includes(number))
        .map(invoiceJson);
      return HttpResponse.json({ items, total_items: items.length });
    }),

    http.post(`${base}/:id/send`, ({ request, params }) =>
      withInvoice(request, params.id, (invoice) => {
        if (invoice.status !== "DRAFT") return unprocessable("CANT_SEND_INVOICE");
        invoice.status = "UNPAID";
        return HttpResponse.json({
          rel: "payer-view",
          href: `https://www.sandbox.paypal.com/invoice/p/#${invoice.id}`,
          method: "GET",
        });
      }),
    ),

    http.post(`${base}/:id/cancel`, ({ request, params }) =>
      withInvoice(request, params.id, (invoice) => {
        if (!["UNPAID", "SENT"].includes(invoice.status)) return unprocessable("CANT_CANCEL");
        invoice.status = "CANCELLED";
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.get(`${base}/:id`, ({ request, params }) =>
      withInvoice(request, params.id, (invoice) => HttpResponse.json(invoiceJson(invoice))),
    ),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v1/notifications/verify-webhook-signature`,
      async ({ request }) => {
        await record(request);
        if (!authorized(request)) return new HttpResponse(null, { status: 401 });
        const text = await request.text();
        const body = JSON.parse(text) as Record<string, unknown>;
        verifications.push({ text, body });
        const valid =
          body.transmission_sig === VALID_SIGNATURE && body.webhook_id === FAKE_WEBHOOK_ID;
        return HttpResponse.json({ verification_status: valid ? "SUCCESS" : "FAILURE" });
      },
    ),

    http.delete(`${base}/:id`, ({ request, params }) =>
      withInvoice(request, params.id, (invoice) => {
        if (invoice.status !== "DRAFT") return unprocessable("CANT_DELETE");
        invoices.delete(invoice.id);
        return new HttpResponse(null, { status: 204 });
      }),
    ),
  ];

  return {
    handlers,
    invoices,
    calls,
    verifications,
    store,
    get tokensIssued() {
      return tokensIssued;
    },
    /** Simulates the client paying part or all of the invoice in the sandbox. */
    pay(id: string, value: string, status: "PAID" | "PARTIALLY_PAID") {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error(`No fake invoice ${id}`);
      invoice.status = status;
      invoice.paidValue = value;
    },
    /** Simulates the freelancer refunding part or all of a payment. */
    refund(id: string, value: string, status: "REFUNDED" | "PARTIALLY_REFUNDED") {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error(`No fake invoice ${id}`);
      invoice.status = status;
      invoice.refundedValue = value;
    },
    /** Simulates the freelancer cancelling the invoice on paypal.com. */
    setStatus(id: string, status: string) {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error(`No fake invoice ${id}`);
      invoice.status = status;
    },
  };
};

export type FakePaypal = ReturnType<typeof createFakePaypal>;
