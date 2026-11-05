import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { createPaypalClient } from "@/lib/paypal";
import { replyHandlers } from "@/lib/reply-handlers";
import { proposedSplit } from "@/lib/invoice-split";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";

// A client asks to pay in parts, and the freelancer approves a split. In one step, the open unpaid
// invoices are cancelled and installment invoices replace them. Real migrations and RLS (PGlite),
// PayPal mocked by msw. An invoice with money on it is never cancelled.

let handle: TestDatabase;
let fake: FakePaypal;
const server = setupServer();
const NOW = new Date("2026-11-02T15:00:00Z");
const THREAD = "thread-split-1";
const REPLY = "abababab-0000-4000-8000-000000000001";
const { milestones: MILESTONE, invoices: INVOICE } = USER_A.rows;
const CREDENTIALS = { clientId: "fake-id", clientSecret: "fake-secret" };

const asUserId =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const act = (payload: unknown, userId = USER_A.userId, pdf?: (id: string) => Promise<unknown>) =>
  replyHandlers({
    runAsUser: asUserId(userId),
    now: () => NOW,
    paypal: () => createPaypalClient(CREDENTIALS),
    ...(pdf ? { pdf } : {}),
  }).post(
    new Request(`http://127.0.0.1:3000/api/replies/${REPLY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: REPLY }) },
  );

const ITEMS = [
  { amountCents: 45000, dueDate: "2026-11-02" },
  { amountCents: 45000, dueDate: "2026-11-15" },
];

type InvoiceRow = {
  id: string;
  status: string;
  amount_cents: string;
  amount_paid_cents: string;
  due_date: string;
  installment_number: number | null;
  installment_count: number | null;
  gmail_thread_id: string | null;
  gmail_thread_subject: string | null;
  link: string | null;
};

const invoices = async () => {
  const { rows } = await handle.db.query<InvoiceRow>(
    `SELECT id::text, status, amount_cents::text, amount_paid_cents::text, due_date::text,
       installment_number, installment_count, gmail_thread_id, gmail_thread_subject, link
     FROM public.invoices WHERE milestone_id = $1 ORDER BY status, installment_number`,
    [MILESTONE],
  );
  return rows;
};

const open = async () => (await invoices()).filter((row) => row.status !== "cancelled");

const remote = (cents: string, number: string) => {
  const invoice = fake.store({
    detail: { currency_code: "USD", invoice_number: number },
    items: [{ unit_amount: { currency_code: "USD", value: cents } }],
  });
  fake.setStatus(invoice.id, "UNPAID");
  return invoice.id;
};

const sentBodies = () =>
  fake.calls.filter((call) => call.method === "POST").map((call) => JSON.stringify(call));

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  const paypalId = remote("900.00", "FPR-SPLIT-1");
  await handle.db.query(`
    DELETE FROM public.messages WHERE invoice_id IN (SELECT id FROM public.invoices WHERE milestone_id = '${MILESTONE}');
    DELETE FROM public.invoices WHERE milestone_id = '${MILESTONE}';
    DELETE FROM public.installment_plans WHERE milestone_id = '${MILESTONE}';
    DELETE FROM public.events WHERE entity = 'invoice';
    UPDATE public.milestones SET status = 'invoiced', percent_bp = 3000 WHERE id = '${MILESTONE}';
    INSERT INTO public.invoices (id, user_id, milestone_id, amount_cents, currency, due_date, status,
        paypal_invoice_id, invoice_number, link, milestone_status_before, gmail_thread_id,
        gmail_thread_subject, reminders_held_at)
      VALUES ('${INVOICE}', '${USER_A.userId}', '${MILESTONE}', 90000, 'USD', '2026-10-20', 'sent',
        '${paypalId}', 'FPR-SPLIT-1', 'https://www.sandbox.paypal.com/invoice/p/#old', 'delivered',
        '${THREAD}', 'Invoice overdue', now());
    INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, draft)
      VALUES ('${USER_A.userId}', '${INVOICE}', 'tier1', '2026-11-03T14:00:00Z', '{}');
    INSERT INTO public.messages (id, user_id, invoice_id, direction, body, thread_id, gmail_message_id,
        ai_classification, review_status)
      VALUES ('${REPLY}', '${USER_A.userId}', '${INVOICE}', 'in', 'Half now, half on the 15th?',
        '${THREAD}', 'reply-1', '{"label":"installments","promisedDate":null,"returnDate":null,"summary":"Asks to split."}', 'pending');
  `);
});

describe("the proposal", () => {
  it("splits the remainder in two, due today and two weeks on", () => {
    expect(proposedSplit(90000, "2026-11-02")).toEqual([
      { amountCents: 45000, dueDate: "2026-11-02" },
      { amountCents: 45000, dueDate: "2026-11-16" },
    ]);
  });

  it("uses the date the client named, if there is one", () => {
    expect(proposedSplit(90000, "2026-11-02", "2026-11-15")).toEqual([
      { amountCents: 45000, dueDate: "2026-11-02" },
      { amountCents: 45000, dueDate: "2026-11-15" },
    ]);
  });

  it("the parts always add up exactly, in whole cents", () => {
    const parts = proposedSplit(100001, "2026-11-02");
    expect(parts.reduce((sum, part) => sum + part.amountCents, 0)).toBe(100001);
  });
});

describe("the signature on a split's invoices", () => {
  const signed = async () => {
    const { rows } = await handle.db.query<{ include_signature: boolean }>(
      "SELECT include_signature FROM public.invoices WHERE milestone_id = $1 AND status <> 'cancelled'",
      [MILESTONE],
    );
    return rows.map((row) => row.include_signature);
  };

  it("follows the box when it's ticked", async () => {
    await act({ action: "split", items: ITEMS, includeSignature: true });
    expect(await signed()).toEqual([true, true]);
  });

  it("follows the box when it's unticked, whatever the old invoice chose", async () => {
    await handle.db.query("UPDATE public.invoices SET include_signature = true");
    await act({ action: "split", items: ITEMS, includeSignature: false });
    expect(await signed()).toEqual([false, false]);
  });

  it("keeps the old invoice's choice when asked with no box, as from Telegram", async () => {
    await handle.db.query("UPDATE public.invoices SET include_signature = true");
    await act({ action: "split", items: ITEMS });
    expect(await signed()).toEqual([true, true]);
  });

  it("refuses anything but on or off", async () => {
    const response = await act({ action: "split", items: ITEMS, includeSignature: "yes" });
    expect(response.status).toBe(400);
  });
});

describe("approving a split", () => {
  it("cancels the open invoice and creates the installments, in one step", async () => {
    const response = await act({ action: "split", items: ITEMS });
    expect(response.status).toBe(200);
    const rows = await invoices();
    expect(rows.filter((row) => row.status === "cancelled").map((row) => row.id)).toEqual([
      INVOICE,
    ]);
    expect(await open()).toMatchObject([
      {
        status: "sent",
        amount_cents: "45000",
        due_date: "2026-11-02",
        installment_number: 1,
        installment_count: 2,
      },
      {
        status: "sent",
        amount_cents: "45000",
        due_date: "2026-11-15",
        installment_number: 2,
        installment_count: 2,
      },
    ]);
  });

  it("each new invoice has its own PayPal invoice and pay link", async () => {
    await act({ action: "split", items: ITEMS });
    const rows = await open();
    expect(new Set(rows.map((row) => row.link)).size).toBe(2);
    expect(rows.every((row) => row.link?.startsWith("https://"))).toBe(true);
  });

  it("records the plan as made from the client's request", async () => {
    await act({ action: "split", items: ITEMS });
    const { rows } = await handle.db.query<{ created_from: string; total_cents: string }>(
      `SELECT created_from, total_cents::text FROM public.installment_plans
       WHERE milestone_id = $1 AND status = 'active'`,
      [MILESTONE],
    );
    expect(rows).toEqual([{ created_from: "client_request", total_cents: "90000" }]);
  });

  it("the new invoices stay on the client's thread, and aren't on hold", async () => {
    await act({ action: "split", items: ITEMS });
    const rows = await open();
    expect(rows.map((row) => row.gmail_thread_id)).toEqual([THREAD, THREAD]);
    expect(rows.map((row) => row.gmail_thread_subject)).toEqual([
      "Invoice overdue",
      "Invoice overdue",
    ]);
    const { rows: holds } = await handle.db.query<{ held: boolean }>(
      `SELECT reminders_held_at IS NOT NULL AS held FROM public.invoices
       WHERE milestone_id = $1 AND status <> 'cancelled'`,
      [MILESTONE],
    );
    expect(holds.every((row) => !row.held)).toBe(true);
  });

  it("marks the reply done, and stops the old invoice's waiting draft", async () => {
    await act({ action: "split", items: ITEMS });
    const { rows } = await handle.db.query<{ review_status: string; reviewed_action: string }>(
      "SELECT review_status, reviewed_action FROM public.messages WHERE id = $1",
      [REPLY],
    );
    expect(rows[0]).toEqual({ review_status: "done", reviewed_action: "split" });
    const { rows: reminders } = await handle.db.query<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE invoice_id = $1",
      [INVOICE],
    );
    expect(reminders[0]?.approval_status).toBe("skipped");
  });

  it("makes the new PDFs", async () => {
    const made: string[] = [];
    await act({ action: "split", items: ITEMS }, USER_A.userId, (id) => {
      made.push(id);
      return Promise.resolve();
    });
    expect(made.sort()).toEqual((await open()).map((row) => row.id).sort());
  });

  it("no PayPal request uses partial payments", async () => {
    await act({ action: "split", items: ITEMS });
    const bodies = sentBodies().join(" ");
    for (const banned of ["partial_payment", "allow_partial_payment", "minimum_amount_due"]) {
      expect(bodies).not.toContain(banned);
    }
  });

  it("a retry creates nothing more, and a repeat is refused", async () => {
    await act({ action: "split", items: ITEMS });
    const before = await invoices();
    const again = await act({ action: "split", items: ITEMS });
    expect(again.status).toBe(409);
    expect(await invoices()).toEqual(before);
  });

  it("resumes where it stopped, if PayPal failed partway", async () => {
    let failures = 1;
    const real = createPaypalClient(CREDENTIALS);
    const flaky = {
      ...real,
      sendInvoice: (id: string) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("PayPal is down"));
        }
        return real.sendInvoice(id);
      },
    };
    const run = () =>
      replyHandlers({
        runAsUser: asUserId(USER_A.userId),
        now: () => NOW,
        paypal: () => flaky,
      }).post(
        new Request(`http://127.0.0.1:3000/api/replies/${REPLY}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "split", items: ITEMS }),
        }),
        { params: Promise.resolve({ id: REPLY }) },
      );
    expect((await run()).status).toBe(500);
    expect((await run()).status).toBe(200);
    expect(await open()).toHaveLength(2);
    expect((await open()).every((row) => row.status === "sent")).toBe(true);
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.installment_plans WHERE milestone_id = $1",
      [MILESTONE],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("money on an invoice", () => {
  const paidFirstInstallment = async () => {
    const planRows = await handle.db.query<{ id: string }>(
      `INSERT INTO public.installment_plans (user_id, milestone_id, count, total_cents, currency, items, created_from)
       VALUES ($1, $2, 3, 90000, 'USD', '[{"amountCents":30000,"dueDate":"2026-10-01"},{"amountCents":30000,"dueDate":"2026-10-20"},{"amountCents":30000,"dueDate":"2026-11-01"}]', 'setup')
       RETURNING id::text`,
      [USER_A.userId, MILESTONE],
    );
    const planId = planRows.rows[0]?.id ?? "";
    const second = remote("300.00", "FPR-SPLIT-3");
    const third = remote("300.00", "FPR-SPLIT-4");
    const paid = remote("300.00", "FPR-SPLIT-2");
    fake.pay(paid, "300.00", "PAID");
    await handle.db.query(
      `DELETE FROM public.messages WHERE id = '${REPLY}';
       DELETE FROM public.invoices WHERE id = '${INVOICE}';`,
    );
    const insert = (
      number: number,
      status: string,
      paidCents: number,
      paypalId: string,
      invoiceId: string,
      invoiceNumber: string,
    ) =>
      handle.db.query(
        `INSERT INTO public.invoices (id, user_id, milestone_id, amount_cents, amount_paid_cents, currency,
           due_date, status, paypal_invoice_id, invoice_number, link, milestone_status_before,
           installment_number, installment_count, installment_plan_id, gmail_thread_id,
           gmail_thread_subject, reminders_held_at)
         VALUES ('${invoiceId}', $1, $2, 30000, ${String(paidCents)}, 'USD', '2026-10-20', '${status}',
           '${paypalId}', '${invoiceNumber}', 'https://www.sandbox.paypal.com/invoice/p/#x${String(number)}', 'delivered',
           ${String(number)}, 3, $3, '${THREAD}', 'Invoice overdue', now())`,
        [USER_A.userId, MILESTONE, planId],
      );
    const PAID_ID = "cdcdcdcd-0000-4000-8000-000000000001";
    await insert(1, "paid", 30000, paid, PAID_ID, "FPR-SPLIT-2");
    await insert(2, "sent", 0, second, "cdcdcdcd-0000-4000-8000-000000000002", "FPR-SPLIT-3");
    await insert(3, "sent", 0, third, "cdcdcdcd-0000-4000-8000-000000000003", "FPR-SPLIT-4");
    await handle.db.query(
      `INSERT INTO public.messages (id, user_id, invoice_id, direction, body, thread_id, gmail_message_id,
         ai_classification, review_status)
       VALUES ('${REPLY}', '${USER_A.userId}', 'cdcdcdcd-0000-4000-8000-000000000002', 'in', 'Split again?',
         '${THREAD}', 'reply-1', '{"label":"installments","promisedDate":null,"returnDate":null,"summary":"Asks."}', 'pending')`,
    );
    return { paid, PAID_ID };
  };

  const SPLIT_REMAINDER = [
    { amountCents: 20000, dueDate: "2026-11-05" },
    { amountCents: 20000, dueDate: "2026-11-15" },
    { amountCents: 20000, dueDate: "2026-11-25" },
  ];

  it("a paid installment is never cancelled, and only the remainder is split", async () => {
    const { PAID_ID } = await paidFirstInstallment();
    const response = await act({ action: "split", items: SPLIT_REMAINDER });
    expect(response.status).toBe(200);
    const rows = await open();
    const paid = rows.find((row) => row.id === PAID_ID);
    expect(paid).toMatchObject({ status: "paid", amount_paid_cents: "30000" });
    expect(rows).toHaveLength(4);
  });

  it("numbers the new installments after the paid one, and says of how many", async () => {
    await paidFirstInstallment();
    await act({ action: "split", items: SPLIT_REMAINDER });
    const numbers = (await open()).map((row) => [row.installment_number, row.installment_count]);
    expect(numbers.sort()).toEqual([
      [1, 3],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it("a split has to add up to the unpaid remainder, not the whole milestone", async () => {
    await paidFirstInstallment();
    const response = await act({
      action: "split",
      items: [
        { amountCents: 45000, dueDate: "2026-11-05" },
        { amountCents: 45000, dueDate: "2026-11-15" },
      ],
    });
    expect(response.status).toBe(400);
    expect((await open()).filter((row) => row.status === "sent")).toHaveLength(2);
  });

  it("if PayPal says an invoice was paid, nothing at all is cancelled", async () => {
    const { rows } = await handle.db.query<{ paypal_invoice_id: string }>(
      "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
      [INVOICE],
    );
    fake.pay(rows[0]?.paypal_invoice_id ?? "", "900.00", "PAID");
    const response = await act({ action: "split", items: ITEMS });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("paid");
    expect(await open()).toMatchObject([{ id: INVOICE, status: "sent" }]);
    expect(fake.calls.filter((call) => call.path.endsWith("/cancel")).length).toBe(0);
  });

  it("with nothing unpaid left, there's nothing to split", async () => {
    await handle.db.query(
      `UPDATE public.invoices SET status = 'paid', amount_paid_cents = 90000 WHERE id = $1`,
      [INVOICE],
    );
    const response = await act({ action: "split", items: ITEMS });
    expect(response.status).toBe(409);
    expect((await open())[0]?.status).toBe("paid");
  });
});

describe("what's checked", () => {
  it.each([
    [
      "doesn't add up",
      [
        { amountCents: 1000, dueDate: "2026-11-02" },
        { amountCents: 1000, dueDate: "2026-11-15" },
      ],
    ],
    [
      "a past date",
      [
        { amountCents: 45000, dueDate: "2026-10-01" },
        { amountCents: 45000, dueDate: "2026-11-15" },
      ],
    ],
    [
      "no date",
      [
        { amountCents: 45000, dueDate: null },
        { amountCents: 45000, dueDate: "2026-11-15" },
      ],
    ],
    ["one installment", [{ amountCents: 90000, dueDate: "2026-11-02" }]],
    [
      "out of order",
      [
        { amountCents: 45000, dueDate: "2026-11-15" },
        { amountCents: 45000, dueDate: "2026-11-02" },
      ],
    ],
    [
      "a float",
      [
        { amountCents: 450.5, dueDate: "2026-11-02" },
        { amountCents: 89549.5, dueDate: "2026-11-15" },
      ],
    ],
  ])("refuses a split with %s, and changes nothing", async (_name, items) => {
    const response = await act({ action: "split", items });
    expect(response.status).toBe(400);
    expect(await open()).toMatchObject([{ id: INVOICE, status: "sent" }]);
    expect(
      fake.calls.filter((call) => call.method === "POST" && call.path.includes("invoices/")),
    ).toEqual([]);
  });

  it("another user can't approve it", async () => {
    expect((await act({ action: "split", items: ITEMS }, USER_B.userId)).status).toBe(404);
    expect(await open()).toMatchObject([{ id: INVOICE, status: "sent" }]);
  });

  it("the freelancer can split any reply, in case the AI read it wrongly", async () => {
    await handle.db.query(
      `UPDATE public.messages SET ai_classification = '{"label":"dispute","promisedDate":null,"returnDate":null,"summary":"x"}'
       WHERE id = '${REPLY}'`,
    );
    const response = await act({ action: "split", items: ITEMS });
    expect(response.status).toBe(200);
  });
});
