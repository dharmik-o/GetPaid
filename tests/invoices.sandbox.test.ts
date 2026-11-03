import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { USER_A, seedOwnerSql } from "./db/fixtures";
import { openMigratedPglite, type TestDatabase } from "./db/pglite";

// The invoice flow against the real PayPal SANDBOX (`npm run test:paypal:sandbox`), with an
// in-memory database. Every invoice takes partial payments (spec), so this needs a sandbox
// business account in a country where PayPal offers them (see docs/NEEDS_YOU.md).
// PayPal emails nobody: send and cancel use send_to_recipient: false.

let handle: TestDatabase;
const paypal = paypalFromEnv();

const PROJECT = "aaaaaaaa-0000-4000-8000-0000000005a1";
const DEPOSIT = "aaaaaaaa-0000-4000-8000-0000000005b1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000005b2";

const runner: UserDbRunner = (work) => runAsUser(handle.db, USER_A.userId, work);
const handlers = invoiceHandlers({
  runAsUser: runner,
  paypal: () => paypal,
  now: () => new Date(),
});

const post = (body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

type Invoice = { id: string; status: string; link: string | null; invoiceNumber: string };

const expectInvoice = async (response: Response, status: number): Promise<Invoice> => {
  const body = (await response.json()) as { invoice?: Invoice; error?: string };
  expect(body.error, body.error).toBeUndefined();
  expect(response.status).toBe(status);
  if (!body.invoice) throw new Error("no invoice in the response");
  return body.invoice;
};

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
        ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 2, 'Build', 5000, '2026-12-10', 'pay_on_invoice', 'delivered');
  `);
}, 60_000);

afterAll(async () => {
  for (const id of issued) await handlers.cancel(post(), idContext(id)).catch(() => undefined);
  await handle.close();
});

describe("PayPal sandbox: invoice flow", () => {
  it("creates and sends a deposit invoice with a minimum amount due", async () => {
    const invoice = await expectInvoice(
      await handlers.issue(post({ minimumDueCents: 30000 }), idContext(DEPOSIT)),
      201,
    );
    issued.push(invoice.id);
    expect(invoice.status).toBe("sent");
    expect(invoice.link).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
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
