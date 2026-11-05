import { randomBytes } from "node:crypto";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientHandlers } from "@/lib/client-handlers";
import { createSecretBox } from "@/lib/crypto";
import { saveGmailConnection } from "@/lib/gmail-account";
import { listOutbox } from "@/lib/outbox";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { senderHandler } from "@/lib/sender-handler";
import { runAsUser, type Db } from "@/lib/db";
import { loadInvoiceDocument } from "@/lib/invoice-document-data";
import { createPaypalClient } from "@/lib/paypal";
import { paypalWebhookHandler } from "@/lib/paypal-webhook";
import { suggestionFor } from "@/lib/reply-review";
import { retainerHandlers } from "@/lib/retainer-handlers";
import { listRetainerAlerts, listRetainers } from "@/lib/retainers";
import { runScheduler } from "@/lib/scheduler";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { telegramRun } from "@/lib/telegram-cards";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { NO_ARCHIVE } from "../mocks/archive";
import { TEST_LAWS } from "../fixtures/statutes";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";
import {
  createFakePaypal,
  FAKE_WEBHOOK_ID,
  VALID_SIGNATURE,
  type FakePaypal,
} from "../mocks/paypal";

// Retainers end to end: real migrations and RLS (PGlite), PayPal mocked by msw. No model is set up
// in these tests, so drafts come from the fixed template. Nothing here can send an email.

let handle: TestDatabase;
let fake: FakePaypal;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));

const A = USER_A.userId;
const CLIENT = USER_A.rows.clients;
const CHAT_ID = 4242;
const NOW = new Date("2026-12-07T15:00:00Z");
let clock = NOW;

const paypal = () => createPaypalClient({ clientId: "id", clientSecret: "secret" });
const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, A, work);

const handlers = () =>
  retainerHandlers({
    currentUser: () => A,
    runAsCurrent: asA,
    runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
    box: () => box,
    laws: TEST_LAWS,
    paypal,
    now: () => clock,
  });

const schedulerDeps = () => ({
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  runAsUser:
    (userId: string) =>
    <T>(work: (db: Db) => Promise<T>) =>
      runAsUser(handle.db, userId, work),
  box: () => box,
  now: () => clock,
  laws: TEST_LAWS,
  paypal,
});

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3000/api/retainers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const context = (id: string) => ({ params: Promise.resolve({ id }) });

const FIELDS = {
  clientId: CLIENT,
  name: "Monthly hosting",
  amountCents: 20_000,
  currency: "USD",
  unit: "month",
  count: 1,
  startsOn: "2026-12-07",
  method: "invoice",
};

const create = async (overrides: object = {}) => {
  const response = await handlers().create(post({ ...FIELDS, ...overrides }));
  const body = (await response.json()) as {
    id: string;
    errors?: { field: string; message: string }[];
  };
  return { response, body };
};

const createAutoPay = async (overrides: object = {}) => {
  const { response, body } = await create({ method: "auto_pay", ...overrides });
  expect(response.status).toBe(201);
  return body.id;
};

let nextEvent = 1;

const deliver = (eventType: string, resource: unknown, signature = VALID_SIGNATURE) =>
  paypalWebhookHandler({
    runAsService: (work) => runAsService(handle.db, work),
    runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
    now: () => clock,
    paypal,
    webhookId: () => FAKE_WEBHOOK_ID,
  }).post(
    new Request("http://127.0.0.1:3000/api/webhooks/paypal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": signature,
        "paypal-transmission-time": "2026-12-07T15:00:00Z",
      },
      body: JSON.stringify({
        id: `WH-RET-${String(nextEvent++)}`,
        event_type: eventType,
        resource,
      }),
    }),
  );

const subscriptionOf = async (retainerId: string): Promise<string> => {
  const { rows } = await handle.db.query<{ paypal_subscription_id: string }>(
    "SELECT paypal_subscription_id FROM public.retainers WHERE id = $1",
    [retainerId],
  );
  const id = rows[0]?.paypal_subscription_id;
  if (!id) throw new Error("The retainer has no subscription.");
  return id;
};

/** An approved, running auto-pay retainer, as after the client approves. */
const activeAutoPay = async () => {
  const id = await createAutoPay();
  const subscription = await subscriptionOf(id);
  fake.setSubscription(subscription, { status: "ACTIVE" });
  await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription });
  return { id, subscription };
};

const statusOf = async (id: string) => {
  const { rows } = await handle.db.query<{ status: string; paypal_approval_link: string | null }>(
    "SELECT status, paypal_approval_link FROM public.retainers WHERE id = $1",
    [id],
  );
  return rows[0];
};

const invoicesOf = async (id: string) =>
  (
    await handle.db.query<{
      id: string;
      status: string;
      amount_cents: string;
      due_date: string;
      retainer_cycle_on: string;
      retainer_cycle_reason: string;
      link: string | null;
    }>(
      `SELECT id::text, status, amount_cents::text, due_date::text, retainer_cycle_on::text,
         retainer_cycle_reason, link
       FROM public.invoices WHERE retainer_id = $1 ORDER BY retainer_cycle_on, created_at`,
      [id],
    )
  ).rows;

const alertKinds = async (id: string) =>
  (
    await handle.db.query<{ kind: string }>(
      "SELECT kind FROM public.retainer_alerts WHERE retainer_id = $1 ORDER BY created_at, kind",
      [id],
    )
  ).rows.map((row) => row.kind);

const remindersOf = async (invoiceId: string) =>
  (
    await handle.db.query<{
      tier: string;
      approval_status: string;
      draft: unknown;
      sent_at: unknown;
    }>("SELECT tier, approval_status, draft, sent_at FROM public.reminders WHERE invoice_id = $1", [
      invoiceId,
    ])
  ).rows;

const telegramOps = () => runAsService(handle.db, (db) => telegramRun(db, clock, undefined));

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query("UPDATE public.users SET telegram_chat_id = $1 WHERE id = $2", [
    CHAT_ID,
    A,
  ]);
  await asA((db) =>
    saveGmailConnection(db, {
      userId: A,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  fake = createFakePaypal();
  gmail = createFakeGmail();
  server.resetHandlers(...fake.handlers, ...gmail.handlers);
  await handle.db.query("DELETE FROM public.retainers");
  await handle.db.query("DELETE FROM public.reminders");
  await handle.db.query(`UPDATE public.invoices SET status = 'cancelled'`);
});

describe("creating a retainer", () => {
  it("saves an invoice-each-cycle retainer as active, with no PayPal call yet", async () => {
    const { response, body } = await create();
    expect(response.status).toBe(201);
    expect(await statusOf(body.id)).toMatchObject({ status: "active" });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["a start in the past", { startsOn: "2026-12-06" }, "startsOn"],
    ["an end before the start", { endsOn: "2026-12-01" }, "endsOn"],
    ["a client that isn't yours", { clientId: USER_B.rows.clients }, "clientId"],
    ["a project of another client", { projectId: USER_B.rows.projects }, "projectId"],
    ["more than 12 months", { count: 13 }, "count"],
    ["more than 52 weeks", { unit: "week", count: 53 }, "count"],
    ["no amount", { amountCents: 0 }, "amountCents"],
    ["money in a float", { amountCents: 10.5 }, "amountCents"],
    ["an unknown currency", { currency: "XXX" }, "currency"],
    ["an unknown method", { method: "cash" }, "method"],
  ])("refuses %s", async (_label, overrides, field) => {
    const { response, body } = await create(overrides);
    expect(response.status).toBe(400);
    expect(body.errors?.map((error) => error.field)).toContain(field);
  });
});

describe("auto-pay setup", () => {
  it("creates a product, plan and subscription in the sandbox, each with a request id", async () => {
    const id = await createAutoPay();
    const creates = fake.calls.filter(
      (call) => call.method === "POST" && !call.path.includes("oauth2"),
    );
    expect(creates.map((call) => call.path)).toEqual([
      "/v1/catalogs/products",
      "/v1/billing/plans",
      "/v1/billing/subscriptions",
    ]);
    for (const call of creates) expect(call.requestId).toBeTruthy();
    expect(await statusOf(id)).toMatchObject({
      status: "pending_approval",
      paypal_approval_link: expect.stringContaining("sandbox.paypal.com") as string,
    });
  });

  it("sends PayPal the plan's money as a decimal string, with no automatic back-billing", async () => {
    await createAutoPay({ amountCents: 12_345, unit: "week", count: 2 });
    const [plan] = [...fake.plans.values()];
    expect(plan).toMatchObject({
      billing_cycles: [
        {
          frequency: { interval_unit: "WEEK", interval_count: 2 },
          total_cycles: 0,
          pricing_scheme: { fixed_price: { currency_code: "USD", value: "123.45" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: false, payment_failure_threshold: 3 },
    });
  });

  it("gives PayPal a future start, and leaves out a start of today", async () => {
    await createAutoPay({ startsOn: "2026-12-20" });
    await createAutoPay();
    const [later, today] = [...fake.subscriptions.values()];
    expect(later?.body.start_time).toBe("2026-12-20T05:00:00.000Z");
    expect(today?.body.start_time).toBeUndefined();
  });

  it("a retry after a failure carries on, with no second product", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.post(
        "https://api-m.sandbox.paypal.com/v1/billing/plans",
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    const { response } = await create({ method: "auto_pay" });
    expect(response.status).toBe(502);
    const [saved] = await listRetainersForA();
    expect(saved?.setUp).toBe(false);
    const retry = await handlers().act(post({ action: "setup" }), context(saved?.id ?? ""));
    expect(retry.status).toBe(204);
    expect(fake.products.size).toBe(1);
    expect(fake.subscriptions.size).toBe(1);
    expect((await listRetainersForA())[0]?.setUp).toBe(true);
  });

  it("never hands PayPal's own ids to the browser", async () => {
    await createAutoPay();
    const response = await handlers().list();
    const text = await response.text();
    expect(text).not.toContain("PROD-FAKE");
    expect(text).not.toContain("P-FAKE");
    expect(text).not.toContain("request_id");
  });
});

const listRetainersForA = () => asA((db) => listRetainers(db, clock));

describe("cancelling", () => {
  it("cancels a running subscription at PayPal first", async () => {
    const { id, subscription } = await activeAutoPay();
    const response = await handlers().act(post({ action: "cancel" }), context(id));
    expect(response.status).toBe(204);
    expect(fake.subscriptions.get(subscription)?.status).toBe("CANCELLED");
    expect(await statusOf(id)).toMatchObject({ status: "cancelled", paypal_approval_link: null });
  });

  it("doesn't alert the freelancer about their own cancellation", async () => {
    const { id, subscription } = await activeAutoPay();
    await handlers().act(post({ action: "cancel" }), context(id));
    await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: subscription });
    expect(await alertKinds(id)).toEqual([]);
  });

  it("a client who approves after the cancel gets cancelled too, and the freelancer is told", async () => {
    const id = await createAutoPay();
    const subscription = await subscriptionOf(id);
    await handlers().act(post({ action: "cancel" }), context(id));
    fake.setSubscription(subscription, { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription });
    expect(fake.subscriptions.get(subscription)?.status).toBe("CANCELLED");
    expect(await statusOf(id)).toMatchObject({ status: "cancelled" });
    expect(await alertKinds(id)).toEqual(["activated_after_cancel"]);
  });

  it("can't touch another freelancer's retainer", async () => {
    const id = await createAutoPay();
    const other = retainerHandlers({
      currentUser: () => USER_B.userId,
      runAsCurrent: (work) => runAsUser(handle.db, USER_B.userId, work),
      runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
      box: () => box,
      laws: TEST_LAWS,
      paypal,
      now: () => clock,
    });
    const response = await other.act(post({ action: "cancel" }), context(id));
    expect(response.status).toBe(404);
    expect(await statusOf(id)).toMatchObject({ status: "pending_approval" });
  });
});

describe("deleting a client", () => {
  const deleteClientA = () =>
    clientHandlers({ runAsUser: asA }).remove(new Request("http://x"), context(CLIENT));

  it("is refused while auto-pay could still charge them", async () => {
    const { id } = await activeAutoPay();
    const response = await deleteClientA();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("Cancel the retainer");
    expect(await statusOf(id)).toMatchObject({ status: "active" });
  });

  it("is allowed once the retainer is cancelled", async () => {
    const { rows } = await handle.db.query<{ id: string }>(
      `INSERT INTO public.clients (user_id, name, email, country, time_zone)
       VALUES ($1, 'Leaving soon', 'leaving@example.test', 'US', 'America/New_York')
       RETURNING id::text`,
      [A],
    );
    const clientId = rows[0]?.id ?? "";
    const id = await createAutoPay({ clientId });
    const subscription = await subscriptionOf(id);
    fake.setSubscription(subscription, { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription });
    const remove = () =>
      clientHandlers({ runAsUser: asA }).remove(new Request("http://x"), context(clientId));
    expect((await remove()).status).toBe(409);
    await handlers().act(post({ action: "cancel" }), context(id));
    expect((await remove()).status).toBe(204);
  });
});

describe("invoice each cycle", () => {
  it("creates one sandbox invoice per charge date, and emails nobody", async () => {
    const { body } = await create();
    await runScheduler(schedulerDeps());
    const [invoice, ...rest] = await invoicesOf(body.id);
    expect(rest).toEqual([]);
    expect(invoice).toMatchObject({
      status: "sent",
      amount_cents: "20000",
      retainer_cycle_on: "2026-12-07",
      retainer_cycle_reason: "cycle",
    });
    expect(invoice?.link).toContain("sandbox.paypal.com");
    const send = fake.calls.find((call) => call.path.endsWith("/send"));
    expect(JSON.parse(send?.body ?? "{}")).toEqual({
      send_to_invoicer: false,
      send_to_recipient: false,
    });
  });

  it("is safe to re-run, and adds the next cycle only once its date comes", async () => {
    const { body } = await create();
    await runScheduler(schedulerDeps());
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(body.id)).toHaveLength(1);
    clock = new Date("2027-01-07T15:00:00Z");
    await runScheduler(schedulerDeps());
    expect((await invoicesOf(body.id)).map((i) => i.retainer_cycle_on)).toEqual([
      "2026-12-07",
      "2027-01-07",
    ]);
  });

  it("uses the client's date, not UTC's", async () => {
    const { body } = await create({ startsOn: "2026-12-08" });
    // Still 7 Dec in New York.
    clock = new Date("2026-12-08T03:00:00Z");
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(body.id)).toEqual([]);
  });

  it("doesn't bring back a cycle the freelancer cancelled", async () => {
    const { body } = await create();
    await runScheduler(schedulerDeps());
    await handle.db.query(
      `UPDATE public.invoices SET status = 'cancelled' WHERE retainer_id = $1`,
      [body.id],
    );
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(body.id)).toHaveLength(1);
  });

  it("a failed PayPal call only delays it: the next run finishes the same invoice", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.post(
        "https://api-m.sandbox.paypal.com/v2/invoicing/invoices",
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    const { body } = await create();
    await runScheduler(schedulerDeps());
    expect((await invoicesOf(body.id))[0]).toMatchObject({ status: "draft", link: null });
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(body.id)).toMatchObject([{ status: "sent" }]);
    expect(fake.invoices.size).toBe(1);
  });

  it("stops at the end date, and is marked ended", async () => {
    const { body } = await create({ endsOn: "2026-12-07" });
    await runScheduler(schedulerDeps());
    clock = new Date("2027-02-07T15:00:00Z");
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(body.id)).toHaveLength(1);
    expect(await statusOf(body.id)).toMatchObject({ status: "ended" });
  });

  it("runs the normal reminder schedule: a draft with the pay link, waiting for approval", async () => {
    const { body } = await create();
    await runScheduler(schedulerDeps());
    // Net 14 by default, so due on 21 Dec: this is two days overdue, on a Wednesday.
    clock = new Date("2026-12-23T15:00:00Z");
    await runScheduler(schedulerDeps());
    const [invoice] = await invoicesOf(body.id);
    const [reminder] = await remindersOf(invoice?.id ?? "");
    expect(reminder).toMatchObject({ approval_status: "waiting", sent_at: null });
    const draft = storedDraftSchema.parse(reminder?.draft);
    expect(draft.body).toContain(invoice?.link ?? "no link");
    expect(draft.body).toContain("Monthly hosting");
  });

  it("has a document for the PDF, from the database", async () => {
    const { body } = await create();
    await runScheduler(schedulerDeps());
    const [invoice] = await invoicesOf(body.id);
    const loaded = await asA((db) => loadInvoiceDocument(db, invoice?.id ?? ""));
    expect(loaded?.document.invoice.payLink).toBe(invoice?.link);
    expect(loaded?.document.items).toMatchObject([{ name: "Monthly hosting", unitCents: 20_000 }]);
  });
});

/** The order PayPal was asked to do things in, as short names. */
const paypalSteps = () =>
  fake.calls
    .filter((call) => call.method === "POST")
    .flatMap((call) => {
      if (call.path.endsWith("/suspend")) return ["suspend"];
      if (call.path.endsWith("/activate")) return ["activate"];
      if (call.path === "/v2/invoicing/invoices") return ["create invoice"];
      return [];
    });

const payInvoiceAtPaypal = async (retainerId: string) => {
  const [paypalInvoice] = [...fake.invoices.values()];
  const id = paypalInvoice?.id ?? "";
  fake.pay(id, "200.00", "PAID");
  const response = await deliver("INVOICING.INVOICE.PAID", { id });
  expect(response.status).toBe(200);
  return { retainerId, id };
};

/** Running auto-pay whose charge just failed, as PayPal reports it. */
const failedCharge = async () => {
  const active = await activeAutoPay();
  fake.setSubscription(active.subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
  clock = new Date("2027-01-07T16:00:00Z");
  const response = await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
    id: active.subscription,
  });
  expect(response.status).toBe(200);
  return active;
};

describe("a failed auto-pay charge", () => {
  it("suspends the subscription in PayPal before any invoice exists", async () => {
    const { id, subscription } = await failedCharge();
    expect(paypalSteps()).toEqual(["suspend", "create invoice"]);
    expect(fake.subscriptions.get(subscription)?.status).toBe("SUSPENDED");
    expect(await statusOf(id)).toMatchObject({ status: "suspended" });
  });

  it("starts the normal escalation for that cycle", async () => {
    const { id } = await failedCharge();
    const [invoice] = await invoicesOf(id);
    expect(invoice).toMatchObject({
      status: "sent",
      amount_cents: "20000",
      due_date: "2027-01-07",
      retainer_cycle_on: "2027-01-07",
      retainer_cycle_reason: "payment_failed",
    });
    clock = new Date("2027-01-11T16:00:00Z");
    await runScheduler(schedulerDeps());
    const [reminder] = await remindersOf(invoice?.id ?? "");
    expect(reminder).toMatchObject({ tier: "tier1", approval_status: "waiting", sent_at: null });
  });

  it("makes no invoice at all while PayPal hasn't confirmed the suspension", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await activeAutoPay();
    server.use(
      http.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscription}/suspend`,
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    clock = new Date("2027-01-07T16:00:00Z");
    const response = await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(response.status).toBe(200);
    expect(await invoicesOf(id)).toEqual([]);
    expect(fake.invoices.size).toBe(0);
    await runScheduler(schedulerDeps());
    // The refused attempt never reached the fake, so this is the scheduler's retry and what follows.
    expect(paypalSteps()).toEqual(["suspend", "create invoice"]);
    expect((await invoicesOf(id))[0]?.status).toBe("sent");
  });

  it("isn't fooled when PayPal accepts the call but the subscription isn't suspended", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await activeAutoPay();
    server.use(
      http.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscription}/suspend`,
        () => new HttpResponse(null, { status: 204 }),
        { once: true },
      ),
    );
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(await invoicesOf(id)).toEqual([]);
  });

  it("reuses one suspension and one invoice across repeated failure events, and alerts once", async () => {
    const { id, subscription } = await failedCharge();
    clock = new Date("2027-01-12T16:00:00Z");
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(await invoicesOf(id)).toHaveLength(1);
    expect(fake.invoices.size).toBe(1);
    expect(paypalSteps()).toEqual(["suspend", "create invoice"]);
    expect(await alertKinds(id)).toEqual(["payment_failed"]);
  });

  it("doesn't call its own suspension a surprise", async () => {
    const { id, subscription } = await failedCharge();
    await deliver("BILLING.SUBSCRIPTION.SUSPENDED", { id: subscription });
    expect(await alertKinds(id)).toEqual(["payment_failed"]);
  });

  it("takes the amount from the retainer, never from the event", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      id: subscription,
      billing_info: { last_failed_payment: { amount: { value: "1.00", currency_code: "USD" } } },
    });
    expect((await invoicesOf(id))[0]?.amount_cents).toBe("20000");
  });

  it("changes nothing when the signature fails", async () => {
    const { id, subscription } = await activeAutoPay();
    const response = await deliver(
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      { id: subscription },
      "forged",
    );
    expect(response.status).toBe(401);
    expect(await invoicesOf(id)).toEqual([]);
    expect(await alertKinds(id)).toEqual([]);
    expect(paypalSteps()).toEqual([]);
  });

  it("a failed PayPal invoice doesn't fail the webhook: the scheduler finishes it", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await activeAutoPay();
    server.use(
      http.post(
        "https://api-m.sandbox.paypal.com/v2/invoicing/invoices",
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    const response = await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(response.status).toBe(200);
    expect((await invoicesOf(id))[0]?.status).toBe("draft");
    await runScheduler(schedulerDeps());
    expect((await invoicesOf(id))[0]?.status).toBe("sent");
  });
});

describe("the client pays the invoice first", () => {
  it("keeps the subscription suspended until the invoice is paid, then reactivates it", async () => {
    const { id, subscription } = await failedCharge();
    await runScheduler(schedulerDeps());
    expect(fake.subscriptions.get(subscription)?.status).toBe("SUSPENDED");
    expect(paypalSteps()).not.toContain("activate");

    await payInvoiceAtPaypal(id);
    expect(paypalSteps()).toEqual(["suspend", "create invoice", "activate"]);
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
    expect(await statusOf(id)).toMatchObject({ status: "active" });
    expect((await invoicesOf(id))[0]?.status).toBe("paid");
    expect(await alertKinds(id)).toEqual(["payment_failed", "reactivated"]);
  });

  it("no second charge is possible while the invoice is open: PayPal has nothing live to retry", async () => {
    const { id, subscription } = await failedCharge();
    expect((await invoicesOf(id))[0]?.status).toBe("sent");
    expect(fake.subscriptions.get(subscription)?.status).toBe("SUSPENDED");
  });

  it("the next normal charge after reactivating leaves the paid invoice alone, with no warning", async () => {
    const { id, subscription } = await failedCharge();
    await payInvoiceAtPaypal(id);
    fake.setSubscription(subscription, {
      outstanding: "200.00",
      lastPaymentAt: "2027-02-07T15:00:00Z",
    });
    clock = new Date("2027-02-07T16:00:00Z");
    await deliver("PAYMENT.SALE.COMPLETED", { billing_agreement_id: subscription });
    expect((await invoicesOf(id))[0]?.status).toBe("paid");
    expect(await alertKinds(id)).toEqual(["payment_failed", "reactivated"]);
  });

  it("finishes reactivating from the scheduler if PayPal fails at that moment", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await failedCharge();
    server.use(
      http.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscription}/activate`,
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    await payInvoiceAtPaypal(id);
    expect(fake.subscriptions.get(subscription)?.status).toBe("SUSPENDED");
    await runScheduler(schedulerDeps());
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
    expect(await alertKinds(id)).toEqual(["payment_failed", "reactivated"]);
  });

  it("stays suspended if the invoice is cancelled unpaid, since nothing was paid", async () => {
    const { subscription } = await failedCharge();
    const [paypalInvoice] = [...fake.invoices.values()];
    fake.setStatus(paypalInvoice?.id ?? "", "CANCELLED");
    await deliver("INVOICING.INVOICE.CANCELLED", { id: paypalInvoice?.id });
    await runScheduler(schedulerDeps());
    expect(fake.subscriptions.get(subscription)?.status).toBe("SUSPENDED");
    expect(paypalSteps()).not.toContain("activate");
  });

  it("doesn't reactivate a retainer the freelancer cancelled in the meantime", async () => {
    const { id, subscription } = await failedCharge();
    await handlers().act(post({ action: "cancel" }), context(id));
    expect(fake.subscriptions.get(subscription)?.status).toBe("CANCELLED");
    await payInvoiceAtPaypal(id);
    expect(fake.subscriptions.get(subscription)?.status).toBe("CANCELLED");
    expect(paypalSteps()).not.toContain("activate");
    expect(await statusOf(id)).toMatchObject({ status: "cancelled" });
  });

  it("doesn't reactivate after the client cancelled in PayPal", async () => {
    const { id, subscription } = await failedCharge();
    fake.setSubscription(subscription, { status: "CANCELLED" });
    await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: subscription });
    await payInvoiceAtPaypal(id);
    expect(paypalSteps()).not.toContain("activate");
    expect(await statusOf(id)).toMatchObject({ status: "cancelled" });
  });
});

describe("a retry succeeds first", () => {
  it("makes no invoice when PayPal's copy shows the retry already collected it", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, {
      lastFailedAt: "2027-01-07T15:00:00Z",
      lastPaymentAt: "2027-01-07T15:30:00Z",
    });
    clock = new Date("2027-01-07T16:00:00Z");
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(await invoicesOf(id)).toEqual([]);
    expect(fake.invoices.size).toBe(0);
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
    expect(await alertKinds(id)).toEqual(["payment_failed", "recovered"]);
  });

  it("a retry that lands during the suspension: reactivates, and still makes no invoice", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    server.use(
      http.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscription}/suspend`,
        () => {
          fake.setSubscription(subscription, {
            status: "SUSPENDED",
            lastPaymentAt: "2027-01-07T15:59:00Z",
          });
          return new HttpResponse(null, { status: 204 });
        },
        { once: true },
      ),
    );
    clock = new Date("2027-01-07T16:00:00Z");
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    expect(await invoicesOf(id)).toEqual([]);
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
    expect(await statusOf(id)).toMatchObject({ status: "active" });
  });

  it("a payment arriving before the suspension could be placed: no invoice is ever made", async () => {
    const { http, HttpResponse } = await import("msw");
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { lastFailedAt: "2027-01-07T15:00:00Z" });
    server.use(
      http.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscription}/suspend`,
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription });
    fake.setSubscription(subscription, { lastPaymentAt: "2027-01-07T17:00:00Z" });
    await deliver("PAYMENT.SALE.COMPLETED", { billing_agreement_id: subscription });
    await runScheduler(schedulerDeps());
    expect(await invoicesOf(id)).toEqual([]);
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
  });

  it("a retry already in flight when the invoice went out: cancels it, stops reminders, reactivates", async () => {
    const { id, subscription } = await failedCharge();
    const [before] = await invoicesOf(id);
    clock = new Date("2027-01-11T16:00:00Z");
    await runScheduler(schedulerDeps());
    fake.setSubscription(subscription, { lastPaymentAt: "2027-01-11T16:30:00Z" });
    await deliver("PAYMENT.SALE.COMPLETED", { billing_agreement_id: subscription });
    expect((await invoicesOf(id))[0]?.status).toBe("cancelled");
    expect((await remindersOf(before?.id ?? "")).map((r) => r.approval_status)).toEqual([
      "skipped",
    ]);
    expect(fake.subscriptions.get(subscription)?.status).toBe("ACTIVE");
    expect(await alertKinds(id)).toEqual(["payment_failed", "recovered"]);
  });

  it("keeps the invoice while PayPal still shows money outstanding", async () => {
    const { id, subscription } = await failedCharge();
    fake.setSubscription(subscription, {
      outstanding: "200.00",
      lastPaymentAt: "2027-01-11T16:30:00Z",
    });
    await deliver("PAYMENT.SALE.COMPLETED", { billing_agreement_id: subscription });
    expect((await invoicesOf(id))[0]?.status).toBe("sent");
  });

  it("the client paid at PayPal a moment ago: never cancels it, and warns", async () => {
    const { id, subscription } = await failedCharge();
    const [paypalInvoice] = [...fake.invoices.values()];
    fake.pay(paypalInvoice?.id ?? "", "200.00", "PAID");
    fake.setSubscription(subscription, { lastPaymentAt: "2027-01-08T16:30:00Z" });
    await deliver("PAYMENT.SALE.COMPLETED", { billing_agreement_id: subscription });
    expect(paypalInvoice?.status).toBe("PAID");
    expect((await invoicesOf(id))[0]?.status).toBe("paid");
    expect(await alertKinds(id)).toContain("paid_twice");
  });
});

describe("subscription status events", () => {
  it("activation clears the approval link", async () => {
    const { id } = await activeAutoPay();
    expect(await statusOf(id)).toEqual({ status: "active", paypal_approval_link: null });
  });

  it("a cancellation by the client alerts the freelancer on Telegram, once, and in the dashboard", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { status: "CANCELLED" });
    await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: subscription });
    expect(await statusOf(id)).toMatchObject({ status: "cancelled" });
    const ops = await telegramOps();
    expect(ops).toEqual([
      {
        op: "sendText",
        chatId: CHAT_ID,
        text: expect.stringContaining("was cancelled") as string,
      },
    ]);
    expect(await telegramOps()).toEqual([]);
    const alerts = await asA((db) => listRetainerAlerts(db));
    expect(alerts.map((alert) => alert.kind)).toContain("cancelled");
  });

  it("a suspension is flagged the same way", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { status: "SUSPENDED" });
    await deliver("BILLING.SUBSCRIPTION.SUSPENDED", { id: subscription });
    expect(await statusOf(id)).toMatchObject({ status: "suspended" });
    expect(await alertKinds(id)).toEqual(["suspended"]);
  });

  it("believes PayPal's copy, not the event: a late event moves nothing", async () => {
    const { id, subscription } = await activeAutoPay();
    await deliver("BILLING.SUBSCRIPTION.SUSPENDED", { id: subscription, status: "SUSPENDED" });
    expect(await statusOf(id)).toMatchObject({ status: "active" });
    expect(await alertKinds(id)).toEqual([]);
  });

  it("an expired subscription ends the retainer", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { status: "EXPIRED" });
    await deliver("BILLING.SUBSCRIPTION.EXPIRED", { id: subscription });
    expect(await statusOf(id)).toMatchObject({ status: "ended" });
  });

  it("the same event delivered twice applies once", async () => {
    const { id, subscription } = await activeAutoPay();
    fake.setSubscription(subscription, { status: "CANCELLED" });
    const body = JSON.stringify({
      id: "WH-TWICE",
      event_type: "BILLING.SUBSCRIPTION.CANCELLED",
      resource: { id: subscription },
    });
    const send = () =>
      paypalWebhookHandler({
        runAsService: (work) => runAsService(handle.db, work),
        runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
        now: () => clock,
        paypal,
        webhookId: () => FAKE_WEBHOOK_ID,
      }).post(
        new Request("http://127.0.0.1:3000/api/webhooks/paypal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
            "paypal-transmission-id": "tx-1",
            "paypal-transmission-sig": VALID_SIGNATURE,
            "paypal-transmission-time": "2026-12-07T15:00:00Z",
          },
          body,
        }),
      );
    await send();
    const second = (await (await send()).json()) as { outcome: string };
    expect(second.outcome).toBe("duplicate");
    expect(await alertKinds(id)).toEqual(["cancelled"]);
  });

  it("ignores a subscription that isn't ours", async () => {
    const response = await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-NOT-OURS" });
    expect(await response.json()).toEqual({ received: true, outcome: "ignored" });
  });
});

describe("a client's reply on a retainer invoice", () => {
  const classification = {
    label: "installments" as const,
    promisedDate: null,
    returnDate: null,
    summary: "Asked to pay in parts.",
  };

  it("offers no split, since a cycle's invoice stands alone", () => {
    expect(suggestionFor(classification, "2026-12-07", false)).toEqual({ kind: "hold" });
  });

  it("still offers one on a milestone invoice", () => {
    expect(suggestionFor(classification, "2026-12-07")).toEqual({ kind: "split" });
  });
});

describe("the auto-pay approval email", () => {
  const TOKEN = "t".repeat(64);
  const CLIENT_EMAIL = "client-a@example.test";

  const emails = async (retainerId: string) =>
    (
      await handle.db.query<{
        id: string;
        tier: string;
        approval_status: string;
        sent_at: Date | null;
        draft: unknown;
      }>(
        `SELECT id::text, tier, approval_status, sent_at, draft FROM public.reminders
         WHERE retainer_id = $1 ORDER BY created_at`,
        [retainerId],
      )
    ).rows;

  const linkOf = async (retainerId: string): Promise<string> => {
    const { rows } = await handle.db.query<{ link: string }>(
      "SELECT paypal_approval_link AS link FROM public.retainers WHERE id = $1",
      [retainerId],
    );
    return rows[0]?.link ?? "";
  };

  const send = (allowlist = [CLIENT_EMAIL]) =>
    senderHandler({
      runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
      runAsUser:
        (userId: string) =>
        <T>(work: (db: Db) => Promise<T>) =>
          runAsUser(handle.db, userId, work),
      now: () => clock,
      box: () => box,
      oauth: () => ({ clientId: "id", clientSecret: "secret", redirectUri: "http://x" }),
      token: () => TOKEN,
      allowlist: () => new Set(allowlist),
      pdf: () => Promise.reject(new Error("This email has no PDF.")),
      archive: NO_ARCHIVE,
    }).post(
      new Request("http://127.0.0.1:3000/api/internal/sender/run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "{}",
      }),
    );

  const outbox = (id: string, body: unknown) =>
    outboxHandlers({ runAsUser: asA, now: () => clock, laws: TEST_LAWS }).post(
      post(body),
      context(id),
    );

  it("is drafted when auto-pay is set up, and waits for approval: nothing is sent", async () => {
    const id = await createAutoPay();
    const [email, ...rest] = await emails(id);
    expect(rest).toEqual([]);
    expect(email).toMatchObject({ tier: "auto_pay_approval", approval_status: "waiting", sent_at: null });
    const draft = storedDraftSchema.parse(email?.draft);
    expect(draft.kind).toBe("auto_pay_approval");
    expect(draft.body).toContain(await linkOf(id));
    await send();
    expect(gmail.state.sent).toEqual([]);
  });

  it("has the approval link as its only link", async () => {
    const id = await createAutoPay();
    const draft = storedDraftSchema.parse((await emails(id))[0]?.draft);
    const links = draft.body.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual([await linkOf(id)]);
  });

  it("isn't made for invoice-each-cycle, or when PayPal setup failed", async () => {
    const { body } = await create();
    expect(await emails(body.id)).toEqual([]);
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.post(
        "https://api-m.sandbox.paypal.com/v1/billing/subscriptions",
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    const failed = await create({ method: "auto_pay", name: "Failed setup" });
    expect(failed.response.status).toBe(502);
    const [saved] = await listRetainersForA();
    expect(await emails(saved?.id ?? "")).toEqual([]);
    await handlers().act(post({ action: "setup" }), context(saved?.id ?? ""));
    expect(await emails(saved?.id ?? "")).toHaveLength(1);
  });

  it("repeating setup keeps one draft", async () => {
    const id = await createAutoPay();
    await handlers().act(post({ action: "setup" }), context(id));
    expect(await emails(id)).toHaveLength(1);
  });

  it("sits in the Outbox with the fee, and goes out only after approval, with no attachment", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    const items = await asA((db) => listOutbox(db, "waiting", clock));
    expect(items).toContainEqual(
      expect.objectContaining({
        id: email?.id,
        tier: "auto_pay_approval",
        clientName: "Client a",
        payLink: await linkOf(id),
      }),
    );
    expect((await outbox(email?.id ?? "", { action: "approve" })).status).toBe(200);
    await send();
    expect(gmail.state.sent).toHaveLength(1);
    const raw = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(raw).not.toContain("application/pdf");
    expect((await emails(id))[0]?.sent_at).not.toBeNull();
    const { rows } = await handle.db.query<{ retainer_id: string; invoice_id: null }>(
      "SELECT retainer_id::text, invoice_id FROM public.messages WHERE retainer_id = $1",
      [id],
    );
    expect(rows).toEqual([{ retainer_id: id, invoice_id: null }]);
  });

  it("is refused for an address not on the allowlist", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    await outbox(email?.id ?? "", { action: "approve" });
    await send([]);
    expect(gmail.state.sent).toEqual([]);
  });

  it("an edit that drops the link or adds another isn't saved", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    const link = await linkOf(id);
    for (const body of ["Please approve auto-pay.", `${link}\nAlso https://example.test/x`]) {
      expect((await outbox(email?.id ?? "", { action: "edit", subject: "Auto-pay", body })).status).toBe(400);
    }
  });

  it("the client approving stops a draft that hasn't gone out", async () => {
    const id = await createAutoPay();
    const subscription = await subscriptionOf(id);
    fake.setSubscription(subscription, { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription });
    expect((await emails(id))[0]?.approval_status).toBe("skipped");
  });

  it("an approved draft stops too, if the client approved before it went", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    await outbox(email?.id ?? "", { action: "approve" });
    const subscription = await subscriptionOf(id);
    fake.setSubscription(subscription, { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription });
    await send();
    expect(gmail.state.sent).toEqual([]);
  });

  it("cancelling the retainer stops it", async () => {
    const id = await createAutoPay();
    await handlers().act(post({ action: "cancel" }), context(id));
    expect((await emails(id))[0]?.approval_status).toBe("skipped");
  });

  it("the sender stops one whose retainer is no longer waiting, however it got there", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    await outbox(email?.id ?? "", { action: "approve" });
    await handle.db.query("UPDATE public.retainers SET status = 'active' WHERE id = $1", [id]);
    await send();
    expect(gmail.state.sent).toEqual([]);
    expect((await emails(id))[0]?.approval_status).toBe("skipped");
  });

  it("a skipped draft can be made again, and the card shows where it stands", async () => {
    const id = await createAutoPay();
    const [email] = await emails(id);
    const stateOf = async () => (await listRetainersForA()).find((r) => r.id === id)?.approvalEmail;
    expect(await stateOf()).toBe("waiting");
    await outbox(email?.id ?? "", { action: "skip" });
    expect(await stateOf()).toBe("none");
    expect((await handlers().act(post({ action: "email" }), context(id))).status).toBe(204);
    expect(await emails(id)).toHaveLength(2);
    expect(await stateOf()).toBe("waiting");
  });

  it("the link isn't handed to the browser outside the draft", async () => {
    await createAutoPay();
    const text = await (await handlers().list()).text();
    expect(text).not.toContain("ba_token");
  });

  it("the scheduler writes it if the first attempt never finished", async () => {
    const id = await createAutoPay();
    await handle.db.query("UPDATE public.reminders SET draft = NULL WHERE retainer_id = $1", [id]);
    await runScheduler(schedulerDeps());
    expect(storedDraftSchema.parse((await emails(id))[0]?.draft).kind).toBe("auto_pay_approval");
  });

  it("another freelancer can't draft it", async () => {
    const id = await createAutoPay();
    const other = retainerHandlers({
      currentUser: () => USER_B.userId,
      runAsCurrent: (work) => runAsUser(handle.db, USER_B.userId, work),
      runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
      box: () => box,
      laws: TEST_LAWS,
      paypal,
      now: () => clock,
    });
    expect((await other.act(post({ action: "email" }), context(id))).status).toBe(404);
    expect(await emails(id)).toHaveLength(1);
  });
});
