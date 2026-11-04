import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientHandlers } from "@/lib/client-handlers";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { saveGmailConnection } from "@/lib/gmail-account";
import { holdHandlers } from "@/lib/hold-handlers";
import { listHoldsForProject } from "@/lib/milestone-holds";
import { milestoneHandlers } from "@/lib/milestone-handlers";
import { saveMilestonePlan } from "@/lib/milestones";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { createPaypalClient, PAYPAL_SANDBOX_BASE } from "@/lib/paypal";
import { paypalWebhookHandler } from "@/lib/paypal-webhook";
import { runScheduler } from "@/lib/scheduler";
import { senderHandler } from "@/lib/sender-handler";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { telegramRun } from "@/lib/telegram-cards";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
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

// Milestone holds: real migrations and RLS (PGlite), PayPal, Gmail and the bot mocked by msw. No
// model is set up, so the email comes from the fixed template. Nothing here can send an email.

let handle: TestDatabase;
let fake: FakePaypal;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));

const A = USER_A.userId;
const PROJECT = USER_A.rows.projects;
const CLIENT_EMAIL = "client-a@example.test";
const CHAT = 3131;
const TOKEN = "t".repeat(64);
const MILESTONE = "aaaaaaaa-0000-4000-8000-0000000009a1";
const SIBLING = "aaaaaaaa-0000-4000-8000-0000000009a2";
/** A Monday, 15:00 UTC, inside New York's send window. */
const NOW = new Date("2026-12-07T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let clock = NOW;

const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, A, work);
const paypal = () => createPaypalClient({ clientId: "id", clientSecret: "secret" });
const forUser =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>) =>
    runAsUser(handle.db, userId, work);

const core = () => ({
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  runAsUser: forUser,
  box: () => box,
  now: () => clock,
  laws: TEST_LAWS,
  paypal,
});

const handlers = (userId = A) => holdHandlers({ ...core(), currentUser: () => userId });

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const context = (id: string) => ({ params: Promise.resolve({ id }) });

const act = (body: unknown, milestoneId = MILESTONE, userId = A) =>
  handlers(userId).act(post(body), context(milestoneId));

const start = async () => {
  const response = await act({ action: "start" });
  expect(response.status).toBe(201);
  return (await response.json()) as { warning: string | null };
};

const hold = async () => {
  const { rows } = await handle.db.query<{
    status: string;
    paypal_order_id: string | null;
    authorization_id: string | null;
    approval_link: string | null;
    capture_id: string | null;
    authorized_at: Date | null;
  }>(
    `SELECT status, paypal_order_id, authorization_id, approval_link, capture_id, authorized_at
     FROM public.milestone_holds WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [MILESTONE],
  );
  const row = rows[0];
  if (!row) throw new Error("There's no hold.");
  return row;
};

const milestoneStatus = async () => {
  const { rows } = await handle.db.query<{ status: string }>(
    "SELECT status FROM public.milestones WHERE id = $1",
    [MILESTONE],
  );
  return rows[0]?.status;
};

const invoices = async () =>
  (
    await handle.db.query<{
      status: string;
      amount_cents: string;
      amount_paid_cents: string;
      paypal_order_id: string | null;
      invoice_number: string;
    }>(
      `SELECT status, amount_cents::text, amount_paid_cents::text, paypal_order_id, invoice_number
       FROM public.invoices WHERE milestone_id = $1`,
      [MILESTONE],
    )
  ).rows;

const emails = async () =>
  (
    await handle.db.query<{
      id: string;
      tier: string;
      approval_status: string;
      sent_at: Date | null;
      draft: unknown;
    }>(
      `SELECT r.id::text, r.tier, r.approval_status, r.sent_at, r.draft
       FROM public.reminders r JOIN public.milestone_holds h ON h.id = r.hold_id
       WHERE h.milestone_id = $1 ORDER BY r.created_at`,
      [MILESTONE],
    )
  ).rows;

const paypalSteps = () =>
  fake.calls.filter((call) => call.method === "POST" && !call.path.includes("oauth2"));

const stepsNamed = (ending: string) => paypalSteps().filter((c) => c.path.endsWith(ending));

let nextEvent = 1;

const deliver = (eventType: string, resource: unknown, signature = VALID_SIGNATURE) =>
  paypalWebhookHandler({
    runAsService: (work) => runAsService(handle.db, work),
    runAsUser: forUser,
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
        id: `WH-HOLD-${String(nextEvent++)}`,
        event_type: eventType,
        resource,
      }),
    }),
  );

/** The hold, approved by the client and authorized. */
const authorizedHold = async () => {
  await start();
  const orderId = (await hold()).paypal_order_id ?? "";
  fake.approveOrder(orderId);
  const response = await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId });
  expect(response.status).toBe(200);
  return orderId;
};

const setMilestone = (status: string) =>
  handle.db.query("UPDATE public.milestones SET status = $1 WHERE id = $2", [status, MILESTONE]);

/** The freelancer marks it Accepted, as the Project page does. */
const accept = async () => {
  await setMilestone("delivered");
  return milestoneHandlers({
    runAsUser: asA,
    holds: { ...core(), currentUser: () => A },
  }).markStatus(post({ status: "accepted" }), context(MILESTONE));
};

const telegramOps = () => runAsService(handle.db, (db) => telegramRun(db, clock, undefined));

const send = (allowlist = [CLIENT_EMAIL]) =>
  senderHandler({
    runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
    runAsUser: forUser,
    now: () => clock,
    box: () => box,
    oauth: () => ({ clientId: "id", clientSecret: "secret", redirectUri: "http://x" }),
    token: () => TOKEN,
    allowlist: () => new Set(allowlist),
    pdf: () => Promise.reject(new Error("This email has no PDF.")),
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

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `UPDATE public.users SET telegram_chat_id = ${String(CHAT)} WHERE id = '${A}'`,
  );
  await handle.db.query(`UPDATE public.retainers SET status = 'cancelled'`);
  await handle.db.query(`UPDATE public.maintenance_tasks SET status = 'cancelled'`);
  await handle.db.query(
    `INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, amount_cents,
       deadline, payment_mode)
     VALUES ($1, $2, $3, 'USD', 2, 'Build', 150000, '2026-12-20', 'hold'),
            ($4, $2, $3, 'USD', 3, 'Launch', 60000, '2026-12-20', 'pay_on_invoice')`,
    [MILESTONE, A, PROJECT, SIBLING],
  );
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
  await handle.db.query("DELETE FROM public.reminders");
  await handle.db.query("DELETE FROM public.messages");
  await handle.db.query("DELETE FROM public.invoices");
  await handle.db.query("DELETE FROM public.milestone_holds WHERE milestone_id = $1", [MILESTONE]);
  await handle.db.query(
    `UPDATE public.milestones SET status = 'planned', deadline = '2026-12-20', payment_mode = 'hold'
     WHERE id = $1`,
    [MILESTONE],
  );
});

describe("starting a hold", () => {
  it("creates an AUTHORIZE order in the sandbox, with a request id and PayPal's decimal string", async () => {
    await start();
    const [create] = stepsNamed("/v2/checkout/orders");
    expect(create?.requestId).toBeTruthy();
    const [order] = [...fake.orders.values()];
    expect(order?.body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [{ amount: { currency_code: "USD", value: "1500.00" } }],
    });
    expect(await hold()).toMatchObject({ status: "pending_approval", authorization_id: null });
  });

  it("never takes money or asks PayPal to authorize before the client approves", async () => {
    await start();
    expect(stepsNamed("/authorize")).toEqual([]);
    expect(stepsNamed("/capture")).toEqual([]);
  });

  it("drafts an email with the approval link as its only link, waiting for approval", async () => {
    await start();
    const [email, ...rest] = await emails();
    expect(rest).toEqual([]);
    expect(email).toMatchObject({
      tier: "hold_approval",
      approval_status: "waiting",
      sent_at: null,
    });
    const draft = storedDraftSchema.parse(email?.draft);
    expect(draft.kind).toBe("hold_approval");
    const link = (await hold()).approval_link ?? "no link";
    expect(draft.body.match(/https?:\/\/\S+/g)).toEqual([link]);
    await send();
    expect(gmail.state.sent).toEqual([]);
  });

  it("the email goes out only after approval, with no attachment, and only to the allowlist", async () => {
    await start();
    const [email] = await emails();
    expect((await outbox(email?.id ?? "", { action: "approve" })).status).toBe(200);
    await send([]);
    expect(gmail.state.sent).toEqual([]);
    await send();
    expect(gmail.state.sent).toHaveLength(1);
    const raw = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(raw).not.toContain("application/pdf");
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.messages WHERE hold_id IS NOT NULL AND invoice_id IS NULL",
    );
    expect(rows).toHaveLength(1);
  });

  it("is safe to repeat: one order, one draft", async () => {
    await start();
    expect((await act({ action: "start" })).status).toBe(200);
    expect(fake.orders.size).toBe(1);
    expect(await emails()).toHaveLength(1);
  });

  it("a failed PayPal call leaves something to retry, with the same request id", async () => {
    server.use(
      http.post(
        `${PAYPAL_SANDBOX_BASE}/v2/checkout/orders`,
        () => new HttpResponse(null, { status: 500 }),
        {
          once: true,
        },
      ),
    );
    expect((await act({ action: "start" })).status).toBe(502);
    expect((await hold()).status).toBe("creating");
    expect((await act({ action: "start" })).status).toBe(201);
    expect(fake.orders.size).toBe(1);
    expect((await hold()).status).toBe("pending_approval");
  });

  it.each(["delivered", "accepted", "paid"])("refuses a milestone already %s", async (status) => {
    await setMilestone(status);
    expect((await act({ action: "start" })).status).toBe(409);
    expect(fake.orders.size).toBe(0);
  });

  it("refuses a milestone that isn't in hold mode", async () => {
    expect((await act({ action: "start" }, SIBLING)).status).toBe(409);
    expect(fake.orders.size).toBe(0);
  });

  it("warns when the deadline is more than 29 days after the hold, and still starts it", async () => {
    await handle.db.query("UPDATE public.milestones SET deadline = '2027-01-06' WHERE id = $1", [
      MILESTONE,
    ]);
    const { warning } = await start();
    expect(warning).toContain("more than 29 days");
    expect(fake.orders.size).toBe(1);
  });

  it("gives no warning at 29 days", async () => {
    await handle.db.query("UPDATE public.milestones SET deadline = '2027-01-05' WHERE id = $1", [
      MILESTONE,
    ]);
    expect((await start()).warning).toBeNull();
  });

  it("can't start another freelancer's hold", async () => {
    expect((await act({ action: "start" }, MILESTONE, USER_B.userId)).status).toBe(404);
    expect(fake.orders.size).toBe(0);
  });
});

describe("the client approves", () => {
  it("authorizes, and records when", async () => {
    await authorizedHold();
    const row = await hold();
    expect(row.status).toBe("authorized");
    expect(row.authorization_id).toMatch(/^AUTH-FAKE/);
    expect(row.authorized_at?.toISOString()).toBe(NOW.toISOString());
    expect(row.approval_link).toBeNull();
    expect(stepsNamed("/authorize")[0]?.requestId).toBeTruthy();
  });

  it("stops the email if it hasn't gone out", async () => {
    await authorizedHold();
    expect((await emails())[0]?.approval_status).toBe("skipped");
  });

  it("tells the freelancer on Telegram, once", async () => {
    await authorizedHold();
    const ops = await telegramOps();
    expect(ops.filter((op) => op.op === "sendText")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("authorized") as string }),
    ]);
    expect((await telegramOps()).filter((op) => op.op === "sendText")).toEqual([]);
  });

  it("a forged event changes nothing", async () => {
    await start();
    const orderId = (await hold()).paypal_order_id ?? "";
    fake.approveOrder(orderId);
    const response = await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId }, "forged");
    expect(response.status).toBe(401);
    expect((await hold()).status).toBe("pending_approval");
    expect(stepsNamed("/authorize")).toEqual([]);
  });

  it("believes PayPal's copy, not the event", async () => {
    await start();
    const orderId = (await hold()).paypal_order_id ?? "";
    await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId, status: "APPROVED" });
    expect((await hold()).status).toBe("pending_approval");
  });

  it("delivered twice authorizes once", async () => {
    const orderId = await authorizedHold();
    await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId });
    expect(fake.authorizations.size).toBe(1);
  });

  it("the scheduler finishes it if the webhook never came", async () => {
    await start();
    fake.approveOrder((await hold()).paypal_order_id ?? "");
    await runScheduler({ ...core() });
    expect((await hold()).status).toBe("authorized");
  });

  it("a hold voided first is never authorized, even if the client approves later", async () => {
    await start();
    const orderId = (await hold()).paypal_order_id ?? "";
    await act({ action: "void" });
    fake.approveOrder(orderId);
    await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId });
    await runScheduler({ ...core() });
    expect((await hold()).status).toBe("voided");
    expect(stepsNamed("/authorize")).toEqual([]);
  });

  it("ignores an order that isn't ours", async () => {
    const response = await deliver("CHECKOUT.ORDER.APPROVED", { id: "ORDER-NOT-OURS" });
    expect(await response.json()).toEqual({ received: true, outcome: "ignored" });
  });
});

describe("capture on acceptance", () => {
  it("within 3 days: captures without reauthorizing, and the milestone is paid", async () => {
    await authorizedHold();
    clock = new Date(NOW.getTime() + 2 * DAY);
    const response = await accept();
    expect(response.status).toBe(200);
    expect(stepsNamed("/reauthorize")).toEqual([]);
    const [capture] = stepsNamed("/capture");
    expect(capture?.requestId).toBeTruthy();
    expect(JSON.parse(capture?.body ?? "{}")).toMatchObject({ final_capture: true });
    expect(await hold()).toMatchObject({ status: "captured" });
    expect(await milestoneStatus()).toBe("paid");
  });

  it("records the money as a paid invoice, with the order, and the number sent to PayPal", async () => {
    const orderId = await authorizedHold();
    await accept();
    const [invoice] = await invoices();
    expect(invoice).toMatchObject({
      status: "paid",
      amount_cents: "150000",
      amount_paid_cents: "150000",
      paypal_order_id: orderId,
    });
    expect(JSON.parse(stepsNamed("/capture")[0]?.body ?? "{}")).toMatchObject({
      invoice_id: invoice?.invoice_number,
    });
  });

  it("makes no reminder for it, and tells the freelancer", async () => {
    await authorizedHold();
    await telegramOps();
    await accept();
    await runScheduler({ ...core() });
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.reminders r JOIN public.invoices i ON i.id = r.invoice_id WHERE i.milestone_id = $1",
      [MILESTONE],
    );
    expect(rows).toEqual([]);
    expect(await telegramOps()).toContainEqual(
      expect.objectContaining({
        op: "sendText",
        text: expect.stringContaining("captured") as string,
      }),
    );
  });

  it("after day 3: reauthorizes first, and captures on the new authorization", async () => {
    await authorizedHold();
    const first = (await hold()).authorization_id ?? "";
    clock = new Date(NOW.getTime() + 5 * DAY);
    await accept();
    const [reauthorize] = stepsNamed("/reauthorize");
    expect(reauthorize?.path).toContain(first);
    expect(reauthorize?.requestId).toBeTruthy();
    expect(JSON.parse(reauthorize?.body ?? "{}")).toMatchObject({
      amount: { currency_code: "USD", value: "1500.00" },
    });
    const newer = (await hold()).authorization_id ?? "";
    expect(newer).not.toBe(first);
    expect(stepsNamed("/capture")[0]?.path).toContain(newer);
    expect(await hold()).toMatchObject({ status: "captured" });
  });

  it("if PayPal refuses the reauthorization, still captures while the hold lasts", async () => {
    await authorizedHold();
    const first = (await hold()).authorization_id ?? "";
    fake.behaviour.refuseReauthorize = true;
    clock = new Date(NOW.getTime() + 5 * DAY);
    await accept();
    expect(stepsNamed("/capture")[0]?.path).toContain(first);
    expect(await hold()).toMatchObject({ status: "captured" });
  });

  it("after 29 days: doesn't capture, marks it expired, and says what to do", async () => {
    await authorizedHold();
    await telegramOps();
    clock = new Date(NOW.getTime() + 29 * DAY);
    await accept();
    expect(stepsNamed("/capture")).toEqual([]);
    expect(await hold()).toMatchObject({ status: "expired" });
    expect(await milestoneStatus()).toBe("accepted");
    expect(await telegramOps()).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("expired") as string }),
    );
  });

  it("the scheduler marks an expired hold, and a new one can be started", async () => {
    await authorizedHold();
    clock = new Date(NOW.getTime() + 30 * DAY);
    await runScheduler({ ...core() });
    expect((await hold()).status).toBe("expired");
    await setMilestone("in_progress");
    expect((await act({ action: "start" })).status).toBe(201);
    expect(fake.orders.size).toBe(2);
  });

  it("a refused capture leaves it authorized and Accepted, tells the freelancer once, and retries", async () => {
    await authorizedHold();
    await telegramOps();
    fake.behaviour.refuseCapture = true;
    const response = await accept();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { holdError?: string }).holdError).toContain("PayPal");
    expect(await hold()).toMatchObject({ status: "authorized", capture_id: null });
    expect(await milestoneStatus()).toBe("accepted");
    expect((await telegramOps()).filter((op) => op.op === "sendText")).toHaveLength(1);
    await runScheduler({ ...core() });
    expect((await telegramOps()).filter((op) => op.op === "sendText")).toEqual([]);
    fake.behaviour.refuseCapture = false;
    await runScheduler({ ...core() });
    expect(await hold()).toMatchObject({ status: "captured" });
    expect(await invoices()).toHaveLength(1);
    expect(fake.captures.size).toBe(1);
  });

  it("a retry reuses the request id, so an answer lost on the way can't capture twice", async () => {
    await authorizedHold();
    server.use(
      http.post(
        `${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/:id/capture`,
        () => new HttpResponse(null, { status: 500 }),
        {
          once: true,
        },
      ),
    );
    await accept();
    expect((await hold()).status).toBe("authorized");
    await act({ action: "capture" });
    expect(await hold()).toMatchObject({ status: "captured" });
    expect(fake.captures.size).toBe(1);
    expect(await invoices()).toHaveLength(1);
  });

  it("a pending capture isn't called paid until PayPal confirms it", async () => {
    await authorizedHold();
    fake.behaviour.captureStatus = "PENDING";
    await accept();
    expect(await hold()).toMatchObject({ status: "capturing" });
    expect(await milestoneStatus()).toBe("accepted");
    expect((await invoices())[0]?.status).toBe("draft");
    const captureId = (await hold()).capture_id ?? "";
    const held = fake.captures.get(captureId);
    if (held) held.status = "COMPLETED";
    await deliver("PAYMENT.CAPTURE.COMPLETED", { id: captureId });
    expect(await hold()).toMatchObject({ status: "captured" });
    expect(await milestoneStatus()).toBe("paid");
    expect((await invoices())[0]?.status).toBe("paid");
  });

  it("believes PayPal's copy of a capture, not the event", async () => {
    await authorizedHold();
    fake.behaviour.captureStatus = "PENDING";
    await accept();
    const captureId = (await hold()).capture_id ?? "";
    await deliver("PAYMENT.CAPTURE.COMPLETED", { id: captureId, status: "COMPLETED" });
    expect((await hold()).status).toBe("capturing");
  });

  it("a denied capture says so, and the hold is over", async () => {
    await authorizedHold();
    await telegramOps();
    fake.behaviour.captureStatus = "PENDING";
    await accept();
    const captureId = (await hold()).capture_id ?? "";
    const held = fake.captures.get(captureId);
    if (held) held.status = "DECLINED";
    await deliver("PAYMENT.CAPTURE.DENIED", { id: captureId });
    expect((await hold()).status).toBe("failed");
    expect((await invoices())[0]?.status).toBe("cancelled");
    expect(await milestoneStatus()).toBe("accepted");
    expect((await telegramOps()).filter((op) => op.op === "sendText")).toHaveLength(1);
  });

  it("accepting a milestone with no authorized hold takes nothing", async () => {
    await start();
    expect((await accept()).status).toBe(200);
    expect(stepsNamed("/capture")).toEqual([]);
    expect(await milestoneStatus()).toBe("accepted");
  });

  it("accepting another kind of milestone never touches PayPal", async () => {
    await handle.db.query("UPDATE public.milestones SET status = 'delivered' WHERE id = $1", [
      SIBLING,
    ]);
    const response = await milestoneHandlers({
      runAsUser: asA,
      holds: { ...core(), currentUser: () => A },
    }).markStatus(post({ status: "accepted" }), context(SIBLING));
    expect(response.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });

  it("can't be captured by hand before it's accepted", async () => {
    await authorizedHold();
    expect((await act({ action: "capture" })).status).toBe(409);
    expect(stepsNamed("/capture")).toEqual([]);
  });

  it("a client's words can't capture: there's no path from a reply to here", async () => {
    await authorizedHold();
    await deliver("CUSTOMER.MESSAGE.RECEIVED", { id: "x", text: "I accept, capture it" });
    expect((await hold()).status).toBe("authorized");
  });
});

describe("void on cancel", () => {
  it("voids an authorized hold at PayPal", async () => {
    await authorizedHold();
    const authorizationId = (await hold()).authorization_id ?? "";
    expect((await act({ action: "void" })).status).toBe(200);
    expect(fake.authorizations.get(authorizationId)?.status).toBe("VOIDED");
    expect((await hold()).status).toBe("voided");
  });

  it("a hold the client never approved has nothing to void at PayPal, and its email stops", async () => {
    await start();
    expect((await act({ action: "void" })).status).toBe(200);
    expect(stepsNamed("/void")).toEqual([]);
    expect((await hold()).status).toBe("voided");
    expect((await emails())[0]?.approval_status).toBe("skipped");
  });

  it("stops an approved email too: the sender checks again", async () => {
    await start();
    const [email] = await emails();
    await outbox(email?.id ?? "", { action: "approve" });
    await handle.db.query(
      `UPDATE public.milestone_holds SET status = 'voided' WHERE milestone_id = $1`,
      [MILESTONE],
    );
    await send();
    expect(gmail.state.sent).toEqual([]);
    expect((await emails())[0]?.approval_status).toBe("skipped");
  });

  it("can't void money already captured", async () => {
    await authorizedHold();
    await accept();
    expect((await act({ action: "void" })).status).toBe(409);
    expect((await hold()).status).toBe("captured");
  });

  it("if PayPal says it's already captured, records nothing as voided", async () => {
    await authorizedHold();
    const authorizationId = (await hold()).authorization_id ?? "";
    const found = fake.authorizations.get(authorizationId);
    if (found) found.status = "CAPTURED";
    expect((await act({ action: "void" })).status).toBe(502);
    expect((await hold()).status).toBe("authorized");
  });

  it("a void made in PayPal itself is noticed", async () => {
    await authorizedHold();
    const authorizationId = (await hold()).authorization_id ?? "";
    await telegramOps();
    const found = fake.authorizations.get(authorizationId);
    if (found) found.status = "VOIDED";
    await deliver("PAYMENT.AUTHORIZATION.VOIDED", { id: authorizationId });
    expect((await hold()).status).toBe("voided");
    expect((await telegramOps()).filter((op) => op.op === "sendText")).toHaveLength(1);
  });

  it("another freelancer can't void it", async () => {
    await authorizedHold();
    expect((await act({ action: "void" }, MILESTONE, USER_B.userId)).status).toBe(404);
    expect((await hold()).status).toBe("authorized");
  });
});

describe("while a hold is live", () => {
  const plan = (mode: string) => ({
    milestones: [
      {
        id: USER_A.rows.milestones,
        name: "Design",
        percentBp: 3000,
        deadline: "2026-12-01",
        paymentMode: "deposit",
      },
      {
        id: MILESTONE,
        name: "Build",
        amountCents: 150_000,
        deadline: "2026-12-20",
        paymentMode: mode,
      },
      {
        id: SIBLING,
        name: "Launch",
        amountCents: 60_000,
        deadline: "2026-12-20",
        paymentMode: "pay_on_invoice",
      },
    ],
  });

  it("its milestone can't change mode", async () => {
    await authorizedHold();
    const result = await asA((db) => saveMilestonePlan(db, PROJECT, plan("pay_on_invoice")));
    expect(result.ok).toBe(false);
  });

  it("its milestone can't be removed", async () => {
    await authorizedHold();
    const { milestones } = plan("hold");
    const result = await asA((db) =>
      saveMilestonePlan(db, PROJECT, {
        milestones: milestones.filter((m) => m.id !== MILESTONE),
      }),
    );
    expect(result.ok).toBe(false);
    expect(await milestoneStatus()).toBe("planned");
  });

  it("its client can't be deleted", async () => {
    await authorizedHold();
    const response = await clientHandlers({ runAsUser: asA }).remove(
      new Request("http://x"),
      context(USER_A.rows.clients),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("hold");
  });

  it("the Project page sees where it stands, and no PayPal ids", async () => {
    await authorizedHold();
    const holds = await asA((db) => listHoldsForProject(db, PROJECT, clock));
    expect(holds.find((item) => item.milestoneId === MILESTONE)).toMatchObject({
      status: "authorized",
      amountCents: 150_000,
    });
    expect(JSON.stringify(holds)).not.toContain("AUTH-FAKE");
    expect(JSON.stringify(holds)).not.toContain("ORDER-FAKE");
  });
});

describe("after capture", () => {
  const captured = async () => {
    await authorizedHold();
    await accept();
    return (await hold()).capture_id ?? "";
  };

  it("a refund is recorded, for the amount PayPal says", async () => {
    await captured();
    const [invoice] = await invoices();
    fake.refunds.set("REF-1", { value: "500.00", currency: "USD" });
    await deliver("PAYMENT.CAPTURE.REFUNDED", { id: "REF-1", invoice_id: invoice?.invoice_number });
    expect((await invoices())[0]).toMatchObject({
      status: "refunded",
      amount_paid_cents: "100000",
    });
  });

  it("the same refund delivered twice counts once", async () => {
    await captured();
    const [invoice] = await invoices();
    fake.refunds.set("REF-2", { value: "500.00", currency: "USD" });
    const body = { id: "REF-2", invoice_id: invoice?.invoice_number };
    await deliver("PAYMENT.CAPTURE.REFUNDED", body);
    await deliver("PAYMENT.CAPTURE.REFUNDED", body);
    expect((await invoices())[0]?.amount_paid_cents).toBe("100000");
  });

  it("a dispute marks the milestone disputed", async () => {
    await captured();
    const [invoice] = await invoices();
    await deliver("CUSTOMER.DISPUTE.CREATED", {
      disputed_transactions: [{ invoice_number: invoice?.invoice_number }],
    });
    expect((await invoices())[0]?.status).toBe("disputed");
    expect(await milestoneStatus()).toBe("disputed");
  });
});
