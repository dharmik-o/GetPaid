import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPaypalClient, PAYPAL_SANDBOX_BASE } from "@/lib/paypal";
import { paypalWebhookHandler } from "@/lib/paypal-webhook";
import { runAsUser } from "@/lib/db";
import { runAsService } from "@/lib/service-db";
import { USER_A, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import {
  createFakePaypal,
  FAKE_WEBHOOK_ID,
  VALID_SIGNATURE,
  type FakePaypal,
} from "../mocks/paypal";

// The PayPal webhook end to end: real migrations (PGlite) as service_role, PayPal mocked.
// Nothing changes unless PayPal verifies the signature, and amounts come from PayPal's own
// copy of the invoice, never from the event body.

let handle: TestDatabase;
let fake: FakePaypal;
const server = setupServer();

const INVOICE = "aaaaaaaa-0000-4000-8000-0000000000c1";
const MILESTONE = USER_A.rows.milestones;
let paypalId = "";

/** `null` means PAYPAL_WEBHOOK_ID isn't configured. */
const handler = (webhookId: string | null = FAKE_WEBHOOK_ID) =>
  paypalWebhookHandler({
    runAsService: (work) => runAsService(handle.db, work),
    runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
    now: () => new Date(),
    paypal: () => createPaypalClient({ clientId: "id", clientSecret: "secret" }),
    webhookId: () => webhookId ?? undefined,
  });

const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": VALID_SIGNATURE,
  "paypal-transmission-time": "2026-11-03T15:00:00Z",
};

let nextEvent = 1;

const eventJson = (eventType: string, resource: unknown, id = `WH-EVT-${String(nextEvent++)}`) =>
  // Spacing and key order as PayPal might send them: verification must use these exact bytes.
  `{ "id": "${id}",  "event_type": "${eventType}", "resource": ${JSON.stringify(resource)} }`;

const deliver = (body: string, headers: Record<string, string> = HEADERS) =>
  handler().post(
    new Request("http://127.0.0.1:3000/api/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => {
  const { rows } = await handle.db.query<T>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`No row for ${sql}`);
  return row;
};

const invoiceRow = () =>
  one<{ status: string; amount_paid_cents: string }>(
    "SELECT status, amount_paid_cents::text FROM public.invoices WHERE id = $1",
    [INVOICE],
  );

const milestoneStatus = async () =>
  (await one<{ status: string }>("SELECT status FROM public.milestones WHERE id = $1", [MILESTONE]))
    .status;

const reminderStatuses = async () =>
  (
    await handle.db.query<{ tier: string; approval_status: string }>(
      "SELECT tier, approval_status FROM public.reminders WHERE invoice_id = $1 ORDER BY tier",
      [INVOICE],
    )
  ).rows.map((r) => `${r.tier}:${r.approval_status}`);

const eventTypes = async () =>
  (
    await handle.db.query<{ type: string }>(
      "SELECT type FROM public.events WHERE entity_id = $1 ORDER BY created_at, type",
      [INVOICE],
    )
  ).rows.map((r) => r.type);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  const remote = fake.store({
    detail: { currency_code: "USD", invoice_number: "FPR-000900" },
    items: [{ unit_amount: { currency_code: "USD", value: "900.00" } }],
  });
  fake.setStatus(remote.id, "UNPAID");
  paypalId = remote.id;
  await handle.db.query(`
    DELETE FROM public.invoices WHERE milestone_id = '${MILESTONE}';
    DELETE FROM public.events WHERE entity_id = '${INVOICE}';
    UPDATE public.milestones SET status = 'invoiced' WHERE id = '${MILESTONE}';
    INSERT INTO public.invoices (id, user_id, milestone_id, amount_cents, currency, due_date, status,
        paypal_invoice_id, invoice_number, link, milestone_status_before)
      VALUES ('${INVOICE}', '${USER_A.userId}', '${MILESTONE}', 90000, 'USD', '2026-11-17', 'sent',
        '${paypalId}', 'FPR-000900', 'https://www.sandbox.paypal.com/invoice/p/#x', 'planned');
    INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, approval_status, approved_via, draft, sent_at)
      VALUES
        ('${USER_A.userId}', '${INVOICE}', 'courtesy', '2026-11-15T14:00:00Z', 'approved', 'outbox', '{}', '2026-11-15T14:00:00Z'),
        ('${USER_A.userId}', '${INVOICE}', 'tier2', '2026-11-25T14:00:00Z', 'waiting', NULL, '{}', NULL);
  `);
});

afterEach(() => { server.resetHandlers(); });

afterAll(async () => {
  server.close();
  await handle.close();
});

const paidEvent = () => eventJson("INVOICING.INVOICE.PAID", { id: paypalId, status: "PAID" });

describe("signature verification", () => {
  it("rejects an unsigned event without calling PayPal or changing anything", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    const response = await deliver(paidEvent(), { "content-type": "application/json" });
    expect(response.status).toBe(400);
    expect(fake.verifications).toHaveLength(0);
    expect((await invoiceRow()).status).toBe("sent");
  });

  it("rejects a forged event that PayPal doesn't verify, and changes nothing", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    const response = await deliver(paidEvent(), {
      ...HEADERS,
      "paypal-transmission-sig": "forged",
    });
    expect(response.status).toBe(401);
    expect(fake.verifications).toHaveLength(1);
    expect(await invoiceRow()).toEqual({ status: "sent", amount_paid_cents: "0" });
    expect(await milestoneStatus()).toBe("invoiced");
    expect(await reminderStatuses()).toContain("tier2:waiting");
  });

  it("sends PayPal the exact event bytes, the headers and our webhook id", async () => {
    const body = paidEvent();
    await deliver(body);
    const [verification] = fake.verifications;
    expect(verification?.text).toContain(`"webhook_event":${body}`);
    expect(verification?.body).toMatchObject({
      auth_algo: HEADERS["paypal-auth-algo"],
      cert_url: HEADERS["paypal-cert-url"],
      transmission_id: HEADERS["paypal-transmission-id"],
      transmission_sig: VALID_SIGNATURE,
      transmission_time: HEADERS["paypal-transmission-time"],
      webhook_id: FAKE_WEBHOOK_ID,
    });
  });

  it("rejects a body that isn't a JSON object before asking PayPal", async () => {
    expect((await deliver("not json")).status).toBe(400);
    expect((await deliver('["an", "array"]')).status).toBe(400);
    expect(fake.verifications).toHaveLength(0);
  });

  it("answers 503 (PayPal retries later) when the webhook id isn't configured", async () => {
    const response = await handler(null).post(
      new Request("http://127.0.0.1:3000/api/webhooks/paypal", {
        method: "POST",
        headers: HEADERS,
        body: paidEvent(),
      }),
    );
    expect(response.status).toBe(503);
    expect((await invoiceRow()).status).toBe("sent");
  });

  it("answers 503 when PayPal's verification service fails, and changes nothing", async () => {
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v1/notifications/verify-webhook-signature`, () =>
        HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
      ),
    );
    fake.pay(paypalId, "900.00", "PAID");
    expect((await deliver(paidEvent())).status).toBe(503);
    expect((await invoiceRow()).status).toBe("sent");
  });
});

describe("payments", () => {
  it("paid: marks the invoice and milestone Paid and stops every pending reminder", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    expect((await deliver(paidEvent())).status).toBe(200);
    expect(await invoiceRow()).toEqual({ status: "paid", amount_paid_cents: "90000" });
    expect(await milestoneStatus()).toBe("paid");
    // Sent stays in the log; the waiting draft is stopped.
    expect(await reminderStatuses()).toEqual(["courtesy:approved", "tier2:skipped"]);
    expect(await eventTypes()).toContain("invoice.paid");
  });

  it("paid: an approved draft that hasn't gone out is stopped too", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET approval_status = 'approved', approved_via = 'telegram'
       WHERE invoice_id = '${INVOICE}' AND tier = 'tier2'`,
    );
    fake.pay(paypalId, "900.00", "PAID");
    expect((await deliver(paidEvent())).status).toBe(200);
    expect(await reminderStatuses()).toEqual(["courtesy:approved", "tier2:skipped"]);
  });

  it("trusts PayPal's own copy of the invoice, not the event body", async () => {
    // Signed, but stale or wrong: the event says PAID, PayPal's invoice is still unpaid.
    expect((await deliver(paidEvent())).status).toBe(200);
    expect(await invoiceRow()).toEqual({ status: "sent", amount_paid_cents: "0" });
    expect(await reminderStatuses()).toContain("tier2:waiting");
  });

  it("partially paid: records the amount and stops drafts that quote the old balance", async () => {
    fake.pay(paypalId, "750.00", "PARTIALLY_PAID");
    const body = eventJson("INVOICING.INVOICE.UPDATED", { id: paypalId });
    expect((await deliver(body)).status).toBe(200);
    expect(await invoiceRow()).toEqual({ status: "partially_paid", amount_paid_cents: "75000" });
    expect(await milestoneStatus()).toBe("partially_paid");
    expect(await reminderStatuses()).toEqual(["courtesy:approved", "tier2:skipped"]);
  });

  it("handles the same event delivered twice only once", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    const body = paidEvent();
    const first = await deliver(body);
    const second = await deliver(body);
    expect(await first.json()).toEqual({ received: true, outcome: "applied" });
    expect(await second.json()).toEqual({ received: true, outcome: "duplicate" });
    expect((await eventTypes()).filter((t) => t === "invoice.paid")).toHaveLength(1);
  });

  it("refunded: marks the invoice Refunded with the money kept, and leaves the milestone", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    await deliver(paidEvent());
    fake.refund(paypalId, "900.00", "REFUNDED");
    const body = eventJson("INVOICING.INVOICE.REFUNDED", { id: paypalId });
    expect((await deliver(body)).status).toBe(200);
    expect(await invoiceRow()).toEqual({ status: "refunded", amount_paid_cents: "0" });
    expect(await milestoneStatus()).toBe("paid");
    expect(await eventTypes()).toContain("invoice.refunded");
  });

  it("a capture refund finds the invoice by its number", async () => {
    fake.pay(paypalId, "900.00", "PAID");
    fake.refund(paypalId, "300.00", "PARTIALLY_REFUNDED");
    const body = eventJson("PAYMENT.CAPTURE.REFUNDED", { id: "REF-1", invoice_id: "FPR-000900" });
    expect((await deliver(body)).status).toBe(200);
    expect(await invoiceRow()).toEqual({ status: "refunded", amount_paid_cents: "60000" });
  });

  it("cancelled on paypal.com: cancels here and restores the milestone", async () => {
    fake.setStatus(paypalId, "CANCELLED");
    const body = eventJson("INVOICING.INVOICE.CANCELLED", { id: paypalId });
    expect((await deliver(body)).status).toBe(200);
    expect((await invoiceRow()).status).toBe("cancelled");
    expect(await milestoneStatus()).toBe("planned");
    expect(await reminderStatuses()).toContain("tier2:skipped");
  });
});

describe("disputes", () => {
  it("marks the invoice and milestone Disputed and stops reminders", async () => {
    const body = eventJson("CUSTOMER.DISPUTE.CREATED", {
      dispute_id: "PP-D-1",
      disputed_transactions: [{ seller_transaction_id: "TX-1", invoice_number: "FPR-000900" }],
    });
    expect((await deliver(body)).status).toBe(200);
    expect((await invoiceRow()).status).toBe("disputed");
    expect(await milestoneStatus()).toBe("disputed");
    expect(await reminderStatuses()).toContain("tier2:skipped");
    expect(await eventTypes()).toContain("invoice.disputed");
  });

  it("keeps Disputed when a later payment update arrives", async () => {
    await deliver(
      eventJson("CUSTOMER.DISPUTE.CREATED", {
        disputed_transactions: [{ invoice_number: "FPR-000900" }],
      }),
    );
    fake.pay(paypalId, "300.00", "PARTIALLY_PAID");
    await deliver(eventJson("INVOICING.INVOICE.UPDATED", { id: paypalId }));
    expect(await invoiceRow()).toEqual({ status: "disputed", amount_paid_cents: "30000" });
  });
});

describe("events that aren't ours", () => {
  it("are verified, then acknowledged without changes", async () => {
    const unknownInvoice = eventJson("INVOICING.INVOICE.PAID", { id: "INV2-NOT-OURS" });
    const otherType = eventJson("CHECKOUT.ORDER.APPROVED", { id: "ORDER-1" });
    const malformed = eventJson("INVOICING.INVOICE.PAID", { nothing: true });
    for (const body of [unknownInvoice, otherType, malformed]) {
      expect((await deliver(body)).status).toBe(200);
    }
    expect(fake.verifications).toHaveLength(3);
    expect((await invoiceRow()).status).toBe("sent");
  });
});

describe("installments", () => {
  const PLAN = USER_A.rows.installment_plans;

  /** Replaces the plain invoice with installments 1 (USD 300) and 2 (USD 600) of a plan. */
  const installments = async () => {
    const first = fake.store({
      detail: { currency_code: "USD", invoice_number: "FPR-000901" },
      items: [{ unit_amount: { currency_code: "USD", value: "300.00" } }],
    });
    const second = fake.store({
      detail: { currency_code: "USD", invoice_number: "FPR-000902" },
      items: [{ unit_amount: { currency_code: "USD", value: "600.00" } }],
    });
    fake.setStatus(first.id, "UNPAID");
    fake.setStatus(second.id, "UNPAID");
    await handle.db.query(`
      DELETE FROM public.invoices WHERE milestone_id = '${MILESTONE}';
      UPDATE public.installment_plans SET status = 'active' WHERE id = '${PLAN}';
      INSERT INTO public.invoices (user_id, milestone_id, amount_cents, currency, due_date, status,
          paypal_invoice_id, invoice_number, milestone_status_before,
          installment_number, installment_count, installment_plan_id)
        VALUES
          ('${USER_A.userId}', '${MILESTONE}', 30000, 'USD', '2026-11-17', 'sent',
            '${first.id}', 'FPR-000901', 'planned', 1, 2, '${PLAN}'),
          ('${USER_A.userId}', '${MILESTONE}', 60000, 'USD', '2026-12-15', 'sent',
            '${second.id}', 'FPR-000902', NULL, 2, 2, '${PLAN}');
    `);
    return { first: first.id, second: second.id };
  };

  const planStatus = async () =>
    (await one<{ status: string }>("SELECT status FROM public.installment_plans WHERE id = $1", [PLAN]))
      .status;

  it("one installment paid: Partially paid; every one paid: Paid, and the plan is completed", async () => {
    const { first, second } = await installments();
    fake.pay(first, "300.00", "PAID");
    expect((await deliver(eventJson("INVOICING.INVOICE.PAID", { id: first }))).status).toBe(200);
    expect(await milestoneStatus()).toBe("partially_paid");
    expect(await planStatus()).toBe("active");

    fake.pay(second, "600.00", "PAID");
    expect((await deliver(eventJson("INVOICING.INVOICE.PAID", { id: second }))).status).toBe(200);
    expect(await milestoneStatus()).toBe("paid");
    expect(await planStatus()).toBe("completed");
  });

  it("a cancelled installment leaves the milestone alone while another is still open", async () => {
    const { second } = await installments();
    fake.setStatus(second, "CANCELLED");
    await deliver(eventJson("INVOICING.INVOICE.CANCELLED", { id: second }));
    expect(await milestoneStatus()).toBe("invoiced");
  });
});
