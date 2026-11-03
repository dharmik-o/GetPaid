import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { installmentHandlers } from "@/lib/installment-handlers";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { USER_A, seedOwnerSql } from "./db/fixtures";
import { openMigratedPglite, type TestDatabase } from "./db/pglite";

// The invoice flow against the real PayPal SANDBOX (`npm run test:paypal:sandbox`), with an
// in-memory database. Installments are separate invoices, never PayPal partial payments, so
// this works in any sandbox account's country. PayPal emails nobody: send and cancel use
// send_to_recipient: false.

let handle: TestDatabase;
const paypal = paypalFromEnv();

const PROJECT = "aaaaaaaa-0000-4000-8000-0000000005a1";
const DEPOSIT = "aaaaaaaa-0000-4000-8000-0000000005b1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000005b2";
const LAUNCH = "aaaaaaaa-0000-4000-8000-0000000005b3";

const runner: UserDbRunner = (work) => runAsUser(handle.db, USER_A.userId, work);
const handlers = invoiceHandlers({
  runAsUser: runner,
  paypal: () => paypal,
  now: () => new Date(),
});
const plans = installmentHandlers({ runAsUser: runner, now: () => new Date() });

const post = (body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

type Invoice = {
  id: string;
  status: string;
  link: string | null;
  invoiceNumber: string;
  amountCents: number;
  installment: { number: number; count: number } | null;
};

const expectInvoices = async (response: Response, status: number): Promise<Invoice[]> => {
  const body = (await response.json()) as { invoices?: Invoice[]; error?: string };
  expect(body.error, body.error).toBeUndefined();
  expect(response.status).toBe(status);
  if (!body.invoices?.length) throw new Error("no invoices in the response");
  return body.invoices;
};

const expectInvoice = async (response: Response, status: number): Promise<Invoice> => {
  const [first] = await expectInvoices(response, status);
  if (!first) throw new Error("no invoice in the response");
  return first;
};

const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const paypalIdOf = async (invoiceId: string): Promise<string> => {
  const { rows } = await handle.db.query<{ paypal_invoice_id: string }>(
    "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
    [invoiceId],
  );
  return rows[0]?.paypal_invoice_id ?? "";
};

const issued: string[] = [];

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  // A per-run start for invoice numbers, so reruns never meet numbers from earlier runs.
  await handle.db.query(
    `SELECT setval('public.invoice_number_seq', ${String(Date.now() % 1_000_000_000)})`,
  );
  await handle.db.query(`
    UPDATE public.clients SET email = 'sandbox-client@example.com' WHERE id = '${USER_A.rows.clients}';
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Website redesign (sandbox test)', 300000, 'USD', '2026-12-31');
    INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode, status)
      VALUES
        ('${DEPOSIT}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'Design', 3000, '2026-12-01', 'deposit', 'planned'),
        ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 2, 'Build', 5000, '2026-12-10', 'pay_on_invoice', 'delivered'),
        ('${LAUNCH}', '${USER_A.userId}', '${PROJECT}', 'USD', 3, 'Launch', 2000, '2026-12-20', 'pay_on_invoice', 'delivered');
  `);
}, 60_000);

afterAll(async () => {
  for (const id of issued) await handlers.cancel(post(), idContext(id)).catch(() => undefined);
  await handle.close();
});

describe("PayPal sandbox: invoice flow", () => {
  it("a deposit is installment 1 now and installment 2 on delivery, each its own invoice", async () => {
    const first = await expectInvoice(
      await handlers.issue(post({ depositCents: 30000 }), idContext(DEPOSIT)),
      201,
    );
    issued.push(first.id);
    expect(first).toMatchObject({ status: "sent", installment: { number: 1, count: 2 } });
    expect(first.link).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    const rest = await expectInvoice(
      await handlers.issue(post({ installment: 2 }), idContext(DEPOSIT)),
      201,
    );
    expect(rest).toMatchObject({ status: "sent", amountCents: 60000 });
    expect((await paypal.getInvoice(await paypalIdOf(rest.id))).amountCents).toBe(60000);
    // Cancelling either cancels the whole (unpaid) plan.
    const cancelled = await handlers.cancel(post(), idContext(rest.id));
    expect(cancelled.status).toBe(200);
    expect((await paypal.getInvoice(await paypalIdOf(first.id))).status).toBe("CANCELLED");
  });

  it("a setup plan invoices every installment together, with their own due dates", async () => {
    const saved = await plans.save(
      new Request("http://127.0.0.1:3000/api/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { amountCents: 30000, dueDate: inDays(7) },
            { amountCents: 30000, dueDate: inDays(21) },
          ],
        }),
      }),
      idContext(LAUNCH),
    );
    expect(saved.status).toBe(200);
    const invoices = await expectInvoices(await handlers.issue(post(), idContext(LAUNCH)), 201);
    expect(invoices.map((i) => i.installment?.number)).toEqual([1, 2]);
    for (const invoice of invoices) {
      const remote = await paypal.getInvoice(await paypalIdOf(invoice.id));
      expect(["SENT", "UNPAID"]).toContain(remote.status);
      expect(remote.amountCents).toBe(30000);
    }
    const cancelled = await handlers.cancel(post(), idContext(invoices[0]?.id ?? ""));
    expect(cancelled.status).toBe(200);
  });

  it("a retry creates no duplicate: the same invoice comes back", async () => {
    const first = await expectInvoice(await handlers.issue(post(), idContext(BUILD)), 201);
    issued.push(first.id);
    const again = await expectInvoice(await handlers.issue(post(), idContext(BUILD)), 200);
    expect(again.id).toBe(first.id);
    expect(await paypalIdOf(again.id)).toBe(await paypalIdOf(first.id));
  });

  it("cancels the invoice in PayPal", async () => {
    const id = issued.at(-1) ?? "";
    const cancelled = await expectInvoice(await handlers.cancel(post(), idContext(id)), 200);
    expect(cancelled.status).toBe("cancelled");
    expect((await paypal.getInvoice(await paypalIdOf(id))).status).toBe("CANCELLED");
  });
});
