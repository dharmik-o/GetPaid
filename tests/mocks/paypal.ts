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

export type FakeSubscription = {
  id: string;
  status: string;
  outstanding: string;
  lastPaymentAt: string | null;
  lastFailedAt: string | null;
  body: Record<string, unknown>;
};

export type FakeOrder = {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  body: Record<string, unknown>;
  authorizationId: string | null;
};

export type FakeAuthorization = {
  id: string;
  orderId: string;
  status: "CREATED" | "CAPTURED" | "VOIDED" | "EXPIRED";
  value: string;
  currency: string;
};

export type FakeCapture = { id: string; status: string; authorizationId: string; value: string };

export const createFakePaypal = () => {
  const orders = new Map<string, FakeOrder>();
  const authorizations = new Map<string, FakeAuthorization>();
  const captures = new Map<string, FakeCapture>();
  const refunds = new Map<string, { value: string; currency: string }>();
  /** Answers to set for the next calls: what a test wants PayPal to do. */
  const behaviour = {
    refuseReauthorize: false,
    captureStatus: "COMPLETED",
    refuseCapture: false,
  };
  const products = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, FakeSubscription>();
  /** Like the real sandbox for these calls: a repeated request id returns the first answer. */
  const byRequestId = new Map<string, string>();
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

  /** A create call keyed by PayPal-Request-Id: the id already made for it, or a new one. */
  const idFor = (request: Request, prefix: string): { id: string; isNew: boolean } => {
    const key = `${prefix}:${request.headers.get("paypal-request-id") ?? ""}`;
    const known = byRequestId.get(key);
    if (known) return { id: known, isNew: false };
    const id = `${prefix}-FAKE-${String(nextId++).padStart(4, "0")}`;
    byRequestId.set(key, id);
    return { id, isNew: true };
  };

  const subscriptionJson = (subscription: FakeSubscription) => ({
    id: subscription.id,
    status: subscription.status,
    billing_info: {
      outstanding_balance: { currency_code: "USD", value: subscription.outstanding },
      ...(subscription.lastPaymentAt ? { last_payment: { time: subscription.lastPaymentAt } } : {}),
      ...(subscription.lastFailedAt
        ? { last_failed_payment: { time: subscription.lastFailedAt } }
        : {}),
    },
    links: [
      {
        rel: "approve",
        href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${subscription.id}`,
      },
    ],
  });

  const orderJson = (order: FakeOrder) => {
    const units = order.body.purchase_units as { amount: { value: string } }[];
    return {
      id: order.id,
      status: order.status,
      purchase_units: order.authorizationId
        ? [
            {
              ...units[0],
              payments: { authorizations: [{ id: order.authorizationId, status: "CREATED" }] },
            },
          ]
        : units,
      links:
        order.status === "CREATED"
          ? [
              {
                rel: "payer-action",
                href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`,
              },
            ]
          : [],
    };
  };

  const handlers: HttpHandler[] = [
    http.post(`${PAYPAL_SANDBOX_BASE}/v2/checkout/orders`, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { id, isNew } = idFor(request, "ORDER");
      if (isNew) {
        orders.set(id, {
          id,
          status: "CREATED",
          body: (await request.json()) as Record<string, unknown>,
          authorizationId: null,
        });
      }
      const order = orders.get(id);
      return order
        ? HttpResponse.json(orderJson(order), { status: 201 })
        : new HttpResponse(null, { status: 500 });
    }),

    http.get(`${PAYPAL_SANDBOX_BASE}/v2/checkout/orders/:id`, async ({ request, params }) => {
      await record(request);
      const order = orders.get(String(params.id));
      return order
        ? HttpResponse.json(orderJson(order))
        : HttpResponse.json({ name: "RESOURCE_NOT_FOUND", debug_id: "f" }, { status: 404 });
    }),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v2/checkout/orders/:id/authorize`,
      async ({ request, params }) => {
        await record(request);
        const order = orders.get(String(params.id));
        if (!order) return HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
        if (order.status === "COMPLETED") return HttpResponse.json(orderJson(order), { status: 201 });
        if (order.status !== "APPROVED") return unprocessable("ORDER_NOT_APPROVED");
        const id = `AUTH-FAKE-${String(nextId++).padStart(4, "0")}`;
        const unit = (order.body.purchase_units as { amount: { value: string; currency_code: string } }[])[0];
        authorizations.set(id, {
          id,
          orderId: order.id,
          status: "CREATED",
          value: unit?.amount.value ?? "0.00",
          currency: unit?.amount.currency_code ?? "USD",
        });
        order.status = "COMPLETED";
        order.authorizationId = id;
        return HttpResponse.json(orderJson(order), { status: 201 });
      },
    ),

    http.get(`${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/:id`, async ({ request, params }) => {
      await record(request);
      const found = authorizations.get(String(params.id));
      return found
        ? HttpResponse.json({ id: found.id, status: found.status })
        : HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    }),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/:id/reauthorize`,
      async ({ request, params }) => {
        await record(request);
        const found = authorizations.get(String(params.id));
        if (!found) return HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
        if (behaviour.refuseReauthorize) return unprocessable("REAUTHORIZE_NOT_ALLOWED");
        const id = `AUTH-FAKE-${String(nextId++).padStart(4, "0")}`;
        authorizations.set(id, { ...found, id, status: "CREATED" });
        found.status = "VOIDED";
        return HttpResponse.json({ id, status: "CREATED" }, { status: 201 });
      },
    ),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/:id/capture`,
      async ({ request, params }) => {
        await record(request);
        const found = authorizations.get(String(params.id));
        if (!found) return HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
        const key = `CAPTURE:${request.headers.get("paypal-request-id") ?? ""}`;
        const seen = byRequestId.get(key);
        const again = seen ? captures.get(seen) : undefined;
        if (again) return HttpResponse.json({ id: again.id, status: again.status }, { status: 201 });
        if (behaviour.refuseCapture) return unprocessable("AUTHORIZATION_DENIED");
        if (found.status !== "CREATED") return unprocessable("AUTHORIZATION_ALREADY_CAPTURED");
        const id = `CAP-FAKE-${String(nextId++).padStart(4, "0")}`;
        byRequestId.set(key, id);
        found.status = "CAPTURED";
        captures.set(id, {
          id,
          status: behaviour.captureStatus,
          authorizationId: found.id,
          value: found.value,
        });
        return HttpResponse.json({ id, status: behaviour.captureStatus }, { status: 201 });
      },
    ),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/:id/void`,
      async ({ request, params }) => {
        await record(request);
        const found = authorizations.get(String(params.id));
        if (!found) return HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
        if (found.status === "CAPTURED") return unprocessable("PREVIOUSLY_CAPTURED");
        found.status = "VOIDED";
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.get(`${PAYPAL_SANDBOX_BASE}/v2/payments/captures/:id`, async ({ request, params }) => {
      await record(request);
      const found = captures.get(String(params.id));
      return found
        ? HttpResponse.json({ id: found.id, status: found.status })
        : HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    }),

    http.get(`${PAYPAL_SANDBOX_BASE}/v2/payments/refunds/:id`, async ({ request, params }) => {
      await record(request);
      const found = refunds.get(String(params.id));
      return found
        ? HttpResponse.json({
            id: params.id,
            status: "COMPLETED",
            amount: { value: found.value, currency_code: found.currency },
          })
        : HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    }),

    http.post(`${PAYPAL_SANDBOX_BASE}/v1/catalogs/products`, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { id, isNew } = idFor(request, "PROD");
      if (isNew) products.set(id, (await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id }, { status: 201 });
    }),

    http.post(`${PAYPAL_SANDBOX_BASE}/v1/billing/plans`, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { id, isNew } = idFor(request, "P");
      if (isNew) plans.set(id, (await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id }, { status: 201 });
    }),

    http.post(`${PAYPAL_SANDBOX_BASE}/v1/billing/subscriptions`, async ({ request }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { id, isNew } = idFor(request, "I");
      if (isNew) {
        subscriptions.set(id, {
          id,
          status: "APPROVAL_PENDING",
          outstanding: "0.00",
          lastPaymentAt: null,
          lastFailedAt: null,
          body: (await request.json()) as Record<string, unknown>,
        });
      }
      const subscription = subscriptions.get(id);
      return subscription
        ? HttpResponse.json(subscriptionJson(subscription), { status: 201 })
        : new HttpResponse(null, { status: 500 });
    }),

    http.get(`${PAYPAL_SANDBOX_BASE}/v1/billing/subscriptions/:id`, async ({ request, params }) => {
      await record(request);
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const subscription = subscriptions.get(String(params.id));
      return subscription
        ? HttpResponse.json(subscriptionJson(subscription))
        : HttpResponse.json({ name: "RESOURCE_NOT_FOUND", debug_id: "fake" }, { status: 404 });
    }),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v1/billing/subscriptions/:id/cancel`,
      async ({ request, params }) => {
        await record(request);
        if (!authorized(request)) return new HttpResponse(null, { status: 401 });
        const subscription = subscriptions.get(String(params.id));
        if (!subscription) {
          return HttpResponse.json({ name: "RESOURCE_NOT_FOUND", debug_id: "f" }, { status: 404 });
        }
        if (!["ACTIVE", "SUSPENDED"].includes(subscription.status)) {
          return unprocessable("SUBSCRIPTION_STATUS_INVALID");
        }
        subscription.status = "CANCELLED";
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v1/billing/subscriptions/:id/suspend`,
      async ({ request, params }) => {
        await record(request);
        if (!authorized(request)) return new HttpResponse(null, { status: 401 });
        const subscription = subscriptions.get(String(params.id));
        if (subscription?.status !== "ACTIVE") return unprocessable("SUBSCRIPTION_STATUS_INVALID");
        subscription.status = "SUSPENDED";
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.post(
      `${PAYPAL_SANDBOX_BASE}/v1/billing/subscriptions/:id/activate`,
      async ({ request, params }) => {
        await record(request);
        if (!authorized(request)) return new HttpResponse(null, { status: 401 });
        const subscription = subscriptions.get(String(params.id));
        if (subscription?.status !== "SUSPENDED") {
          return unprocessable("SUBSCRIPTION_STATUS_INVALID");
        }
        subscription.status = "ACTIVE";
        return new HttpResponse(null, { status: 204 });
      },
    ),

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
    products,
    plans,
    subscriptions,
    orders,
    authorizations,
    captures,
    refunds,
    behaviour,
    /** Simulates the client approving the order on PayPal's page. */
    approveOrder(id: string) {
      const order = orders.get(id);
      if (!order) throw new Error(`No fake order ${id}`);
      order.status = "APPROVED";
    },
    /** Simulates PayPal moving a subscription along (client approval, failures, a retry). */
    setSubscription(
      id: string,
      change: Partial<
        Pick<FakeSubscription, "status" | "outstanding" | "lastPaymentAt" | "lastFailedAt">
      >,
    ) {
      const subscription = subscriptions.get(id);
      if (!subscription) throw new Error(`No fake subscription ${id}`);
      Object.assign(subscription, change);
    },
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
