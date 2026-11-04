import { z } from "zod";
import { minorDigits } from "./currencies";
import { loadPaypalEnv } from "./env";

// Server-only PayPal REST client, SANDBOX ONLY: the host is fixed below and can't be changed
// by env or input. Money is integer minor units everywhere else; this file is the one place it
// becomes PayPal's decimal strings, and back.

export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

// Money -------------------------------------------------------------------------------------

/** Integer minor units to PayPal's decimal string ("900.00"; "1500" for JPY). String maths only. */
export const toPaypalValue = (minor: number, currency: string): string => {
  const digits = minorDigits(currency);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error(
      `A PayPal amount must be a whole number of minor units above 0; got ${String(minor)}.`,
    );
  }
  if (digits === 0) return String(minor);
  const raw = String(minor).padStart(digits + 1, "0");
  return `${raw.slice(0, -digits)}.${raw.slice(-digits)}`;
};

const PAYPAL_VALUE = /^(\d+)(?:\.(\d+))?$/;

/** PayPal's decimal string to integer minor units. Throws on anything it can't convert exactly. */
export const fromPaypalValue = (value: string, currency: string): number => {
  const digits = minorDigits(currency);
  const match = PAYPAL_VALUE.exec(value);
  const fraction = (match?.[2] ?? "").replace(/0+$/, "");
  const minor = match ? Number(`${match[1] ?? ""}${fraction.padEnd(digits, "0")}`) : NaN;
  if (!match || fraction.length > digits || !Number.isSafeInteger(minor)) {
    throw new Error(
      `PayPal returned an amount (${JSON.stringify(value)}) that isn't a valid ${currency} amount. Check the invoice in the PayPal sandbox.`,
    );
  }
  return minor;
};

export const paypalMoney = (minor: number, currency: string) => ({
  currency_code: currency,
  value: toPaypalValue(minor, currency),
});

// Errors ------------------------------------------------------------------------------------

const errorBodySchema = z
  .object({
    name: z.string(),
    debug_id: z.string(),
    details: z.array(
      z.object({ issue: z.string(), field: z.string(), description: z.string() }).partial(),
    ),
  })
  .partial();

type ErrorDetail = { issue: string | null; field: string | null; description: string | null };

const NO_DETAIL: ErrorDetail = { issue: null, field: null, description: null };

/**
 * A failed PayPal call: PayPal's issue code, the field it concerns, its own short explanation
 * and the debug id. Never request or response bodies, tokens or credentials.
 */
export class PaypalError extends Error {
  readonly issue: string | null;
  readonly field: string | null;

  constructor(
    readonly action: string,
    readonly status: number,
    detail: ErrorDetail,
    readonly debugId: string | null,
    help = `Check the invoice in the PayPal sandbox; debug id ${debugId ?? "none"}.`,
  ) {
    const code = detail.issue
      ? ` (${detail.issue}${detail.field ? ` at ${detail.field}` : ""})`
      : "";
    const says = detail.description ? ` PayPal says: ${detail.description}` : "";
    super(
      status >= 500
        ? `PayPal failed to ${action} (HTTP ${String(status)}). Try again in a minute.`
        : `PayPal rejected ${action}${code}, HTTP ${String(status)}.${says} ${help}`,
    );
    this.name = "PaypalError";
    this.issue = detail.issue;
    this.field = detail.field;
  }
}

const SIGN_IN_HELP =
  "Check that PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your local env file are your PayPal sandbox app's credentials.";

const toPaypalError = async (action: string, response: Response): Promise<PaypalError> => {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};
  const first = body.details?.[0];
  return new PaypalError(
    action,
    response.status,
    {
      issue: first?.issue ?? body.name ?? null,
      field: first?.field ?? null,
      description: first?.description ?? null,
    },
    body.debug_id ?? null,
  );
};

// Invoices ----------------------------------------------------------------------------------

export type InvoiceDraft = {
  /** Sent as PayPal-Request-Id on create (project rule). PayPal Invoicing v2 ignores it, so: */
  requestId: string;
  /**
   * Unique per PayPal account: PayPal refuses a second invoice with the same number, and a
   * retry then gets the existing invoice back. This is what stops duplicates.
   */
  invoiceNumber: string;
  currency: string;
  amountCents: number;
  /** A calendar date (YYYY-MM-DD), or null for due on receipt. */
  dueDate: string | null;
  itemName: string;
  itemDescription: string;
  /** Shown on the invoice: the installment line, totals and other due dates. Null for none. */
  note: string | null;
  recipient: { email: string; name: string };
};

export type PaypalInvoice = {
  id: string;
  status: string;
  currency: string;
  amountCents: number;
  paidCents: number;
  /** Refunded so far; the money the freelancer keeps is paid minus refunded. */
  refundedCents: number;
  /** The page where the client pays; null until the invoice is sent. */
  payerViewUrl: string | null;
};

const moneySchema = z.object({ currency_code: z.string(), value: z.string() });

const invoiceSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  detail: z.object({
    currency_code: z.string(),
    metadata: z.object({ recipient_view_url: z.url().optional() }).optional(),
  }),
  amount: moneySchema,
  payments: z.object({ paid_amount: moneySchema.optional() }).optional(),
  refunds: z.object({ refund_amount: moneySchema.optional() }).optional(),
});

/** Create answers with the invoice, or with only a link to it; either way we need the id. */
const createdSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ href: z.url() }).transform(({ href }) => ({
    id: new URL(href).pathname.split("/").at(-1) ?? "",
  })),
]);

const searchSchema = z.object({
  items: z
    .array(z.object({ id: z.string().min(1), detail: z.object({ invoice_number: z.string() }) }))
    .default([]),
});

const DUPLICATE_NUMBER = "DUPLICATE_INVOICE_NUMBER";

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });

/**
 * Never PayPal partial payments: they aren't offered in every country. A client who pays in
 * parts gets installments, which are separate invoices.
 */
const invoiceBody = (draft: InvoiceDraft) => ({
  detail: {
    currency_code: draft.currency,
    invoice_number: draft.invoiceNumber,
    payment_term: draft.dueDate ? { due_date: draft.dueDate } : { term_type: "DUE_ON_RECEIPT" },
    ...(draft.note ? { note: draft.note } : {}),
  },
  primary_recipients: [
    {
      billing_info: { email_address: draft.recipient.email, business_name: draft.recipient.name },
    },
  ],
  items: [
    {
      name: draft.itemName,
      description: draft.itemDescription,
      quantity: "1",
      unit_amount: paypalMoney(draft.amountCents, draft.currency),
    },
  ],
  configuration: { allow_tip: false },
});

/** Neither PayPal nor the client gets an email from PayPal: reminders go out only after approval. */
const NO_EMAILS = { send_to_invoicer: false, send_to_recipient: false };

/** The PayPal-* headers on a webhook delivery, as PayPal's verify call names them. */
export type WebhookHeaders = {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
};

const verificationSchema = z.object({ verification_status: z.string() });

// Subscriptions (auto-pay retainers) ----------------------------------------------------------

export type PlanDraft = {
  requestId: string;
  productId: string;
  name: string;
  amountCents: number;
  currency: string;
  unit: "week" | "month";
  count: number;
  /** 0 means until cancelled. */
  totalCycles: number;
};

export type SubscriptionDraft = {
  requestId: string;
  planId: string;
  /** Null starts it as soon as the client approves. */
  startTime: Date | null;
  subscriberEmail: string;
  /** Our retainer's id, so a subscription can be traced back to it in PayPal. */
  customId: string;
};

export type PaypalSubscription = {
  id: string;
  status: string;
  /** What PayPal still expects from failed charges. Filled only after its retries run out. */
  outstandingCents: number;
  lastPaymentAt: Date | null;
  lastFailedAt: Date | null;
};

const PAYPAL_NAME_MAX = 127;

/**
 * Outstanding amounts are never billed automatically: a failed charge also gets a normal invoice,
 * so billing it later could charge the client twice. The app suspends at the first failure. The
 * threshold is PayPal's own backstop, in case that suspension can't be placed.
 */
const PAYMENT_PREFERENCES = {
  auto_bill_outstanding: false,
  setup_fee_failure_action: "CONTINUE",
  payment_failure_threshold: 3,
};

const planBody = (draft: PlanDraft) => ({
  product_id: draft.productId,
  name: draft.name.slice(0, PAYPAL_NAME_MAX),
  status: "ACTIVE",
  billing_cycles: [
    {
      frequency: { interval_unit: draft.unit.toUpperCase(), interval_count: draft.count },
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: draft.totalCycles,
      pricing_scheme: { fixed_price: paypalMoney(draft.amountCents, draft.currency) },
    },
  ],
  payment_preferences: PAYMENT_PREFERENCES,
});

const createdIdSchema = z.object({ id: z.string().min(1) });

const createdSubscriptionSchema = z.object({
  id: z.string().min(1),
  links: z.array(z.object({ rel: z.string(), href: z.url() })),
});

const subscriptionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  billing_info: z
    .object({
      outstanding_balance: moneySchema.optional(),
      last_payment: z.object({ time: z.string() }).optional(),
      last_failed_payment: z.object({ time: z.string() }).optional(),
    })
    .optional(),
});

const instantOrNull = (time: string | undefined): Date | null => {
  const instant = time === undefined ? Number.NaN : Date.parse(time);
  return Number.isNaN(instant) ? null : new Date(instant);
};

const subscriptionPath = (id: string): string =>
  `/v1/billing/subscriptions/${encodeURIComponent(id)}`;

export interface PaypalClient {
  /** A product for a retainer: its plan needs one. */
  createProduct(draft: { requestId: string; name: string }): Promise<{ id: string }>;
  /** The fee and interval. */
  createPlan(draft: PlanDraft): Promise<{ id: string }>;
  /** The client's subscription, and the link where they approve it. */
  createSubscription(draft: SubscriptionDraft): Promise<{ id: string; approvalLink: string }>;
  getSubscription(id: string): Promise<PaypalSubscription>;
  cancelSubscription(id: string, reason: string): Promise<void>;
  /** Stops PayPal processing payments for it until it's reactivated. */
  suspendSubscription(id: string, reason: string): Promise<void>;
  activateSubscription(id: string, reason: string): Promise<void>;
  createInvoice(draft: InvoiceDraft): Promise<{ id: string }>;
  sendInvoice(id: string): Promise<void>;
  getInvoice(id: string): Promise<PaypalInvoice>;
  cancelInvoice(id: string): Promise<void>;
  deleteInvoice(id: string): Promise<void>;
  /**
   * Asks PayPal whether a webhook delivery is genuine. `rawBody` must be the exact bytes
   * received and already known to be one JSON object.
   */
  verifyWebhook(headers: WebhookHeaders, rawBody: string, webhookId: string): Promise<boolean>;
}

type Credentials = { clientId: string; clientSecret: string };

/** `raw` is sent as given, for bodies that must keep exact bytes. */
type CallOptions = { body?: unknown; raw?: string; requestId?: string };

const invoicePath = (id: string): string => `/v2/invoicing/invoices/${encodeURIComponent(id)}`;

const NETWORK_RETRY_MS = 1000;

/**
 * fetch, tried once more after a network failure (no answer at all, e.g. a DNS hiccup).
 * Safe for every call here: a repeated create meets the duplicate-number guard, and a repeated
 * send or cancel is refused by PayPal, which the invoice flow reads back.
 */
const fetchWithRetry = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_MS));
    return fetch(url, init);
  }
};

export const createPaypalClient = ({ clientId, clientSecret }: Credentials): PaypalClient => {
  let token: { value: string; expiresAt: number } | undefined;

  const accessToken = async (): Promise<string> => {
    if (token && token.expiresAt > Date.now()) return token.value;
    const response = await fetchWithRetry(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      throw new PaypalError("sign in", response.status, NO_DETAIL, null, SIGN_IN_HELP);
    }
    const parsed = tokenSchema.parse(await response.json());
    // Renew a minute early so a token never expires mid-call.
    token = {
      value: parsed.access_token,
      expiresAt: Date.now() + Math.max(0, parsed.expires_in - 60) * 1000,
    };
    return token.value;
  };

  const send = async (method: string, path: string, options: CallOptions): Promise<Response> =>
    fetchWithRetry(`${PAYPAL_SANDBOX_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...(options.requestId ? { "paypal-request-id": options.requestId } : {}),
      },
      ...(options.raw !== undefined
        ? { body: options.raw }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });

  /** One call; on 401 the token is renewed and the call tried once more. */
  const call = async (
    action: string,
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<unknown> => {
    let response = await send(method, path, options);
    if (response.status === 401) {
      token = undefined;
      response = await send(method, path, options);
    }
    if (!response.ok) throw await toPaypalError(action, response);
    if (response.status === 204) return undefined;
    return response.json().catch(() => undefined);
  };

  const parse = <T>(schema: z.ZodType<T>, action: string, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `PayPal sent an unexpected response to ${action}. Check the invoice in the PayPal sandbox.`,
      );
    }
    return result.data;
  };

  const findByNumber = async (invoiceNumber: string): Promise<{ id: string } | undefined> => {
    const action = "search invoices";
    const body = await call(action, "POST", "/v2/invoicing/search-invoices?page=1&page_size=20", {
      body: { invoice_number: invoiceNumber },
    });
    const match = parse(searchSchema, action, body).items.find(
      (item) => item.detail.invoice_number === invoiceNumber,
    );
    return match ? { id: match.id } : undefined;
  };

  return {
    createProduct: async ({ requestId, name }) => {
      const action = "create product";
      const body = await call(action, "POST", "/v1/catalogs/products", {
        body: { name: name.slice(0, PAYPAL_NAME_MAX), type: "SERVICE" },
        requestId,
      });
      return parse(createdIdSchema, action, body);
    },

    createPlan: async (draft) => {
      const action = "create billing plan";
      const body = await call(action, "POST", "/v1/billing/plans", {
        body: planBody(draft),
        requestId: draft.requestId,
      });
      return parse(createdIdSchema, action, body);
    },

    createSubscription: async (draft) => {
      const action = "create subscription";
      const body = await call(action, "POST", "/v1/billing/subscriptions", {
        body: {
          plan_id: draft.planId,
          custom_id: draft.customId,
          subscriber: { email_address: draft.subscriberEmail },
          application_context: { shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW" },
          ...(draft.startTime ? { start_time: draft.startTime.toISOString() } : {}),
        },
        requestId: draft.requestId,
      });
      const created = parse(createdSubscriptionSchema, action, body);
      const approvalLink = created.links.find((link) => link.rel === "approve")?.href;
      if (!approvalLink) {
        throw new Error(
          "PayPal didn't return an approval link for the subscription. Try again in a minute.",
        );
      }
      return { id: created.id, approvalLink };
    },

    getSubscription: async (id) => {
      const action = "read subscription";
      const remote = parse(
        subscriptionSchema,
        action,
        await call(action, "GET", subscriptionPath(id)),
      );
      const balance = remote.billing_info?.outstanding_balance;
      return {
        id: remote.id,
        status: remote.status,
        outstandingCents:
          balance && Number(balance.value) !== 0
            ? fromPaypalValue(balance.value, balance.currency_code)
            : 0,
        lastPaymentAt: instantOrNull(remote.billing_info?.last_payment?.time),
        lastFailedAt: instantOrNull(remote.billing_info?.last_failed_payment?.time),
      };
    },

    cancelSubscription: async (id, reason) => {
      await call("cancel subscription", "POST", `${subscriptionPath(id)}/cancel`, {
        body: { reason },
      });
    },

    suspendSubscription: async (id, reason) => {
      await call("suspend subscription", "POST", `${subscriptionPath(id)}/suspend`, {
        body: { reason },
      });
    },

    activateSubscription: async (id, reason) => {
      await call("reactivate subscription", "POST", `${subscriptionPath(id)}/activate`, {
        body: { reason },
      });
    },

    /** Creates the invoice, or returns the one already created with this number (a retry). */
    createInvoice: async (draft) => {
      const action = "create invoice";
      try {
        const body = await call(action, "POST", "/v2/invoicing/invoices", {
          body: invoiceBody(draft),
          requestId: draft.requestId,
        });
        return parse(createdSchema, action, body);
      } catch (error) {
        if (!(error instanceof PaypalError) || error.issue !== DUPLICATE_NUMBER) throw error;
        const existing = await findByNumber(draft.invoiceNumber);
        if (!existing) throw error;
        return existing;
      }
    },

    sendInvoice: async (id) => {
      await call("send invoice", "POST", `${invoicePath(id)}/send`, { body: NO_EMAILS });
    },

    getInvoice: async (id) => {
      const action = "read invoice";
      const invoice = parse(invoiceSchema, action, await call(action, "GET", invoicePath(id)));
      const currency = invoice.detail.currency_code;
      const paid = invoice.payments?.paid_amount;
      const refunded = invoice.refunds?.refund_amount;
      return {
        id: invoice.id,
        status: invoice.status,
        currency,
        amountCents: fromPaypalValue(invoice.amount.value, currency),
        paidCents: paid ? fromPaypalValue(paid.value, currency) : 0,
        refundedCents: refunded ? fromPaypalValue(refunded.value, currency) : 0,
        payerViewUrl: invoice.detail.metadata?.recipient_view_url ?? null,
      };
    },

    cancelInvoice: async (id) => {
      await call("cancel invoice", "POST", `${invoicePath(id)}/cancel`, { body: NO_EMAILS });
    },

    deleteInvoice: async (id) => {
      await call("delete draft invoice", "DELETE", invoicePath(id));
    },

    verifyWebhook: async (headers, rawBody, webhookId) => {
      const action = "verify webhook signature";
      // The event goes in byte for byte: re-serialising it could change what PayPal checks.
      // Safe to splice: the caller has checked rawBody parses as a single JSON object.
      const fields = JSON.stringify({ ...headers, webhook_id: webhookId }).slice(0, -1);
      const raw = `${fields},"webhook_event":${rawBody}}`;
      const body = await call(action, "POST", "/v1/notifications/verify-webhook-signature", {
        raw,
      });
      return parse(verificationSchema, action, body).verification_status === "SUCCESS";
    },
  };
};

let shared: PaypalClient | undefined;

/** The app's one sandbox account, from env. Throws a clear message if the credentials are missing. */
export const paypalFromEnv = (): PaypalClient => {
  if (shared) return shared;
  const env = loadPaypalEnv();
  shared = createPaypalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  });
  return shared;
};
