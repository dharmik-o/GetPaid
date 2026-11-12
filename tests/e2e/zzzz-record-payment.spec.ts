import { expect, test } from "@playwright/test";
import pg from "pg";
import { DEMO_USER_ID } from "../../apps/web/src/lib/auth";
import { DATABASE_URL } from "./env";

// E1 in a real browser: a bank transfer recorded on an overdue invoice. Its own project, made and
// removed here, so no other spec sees it; named to run last.

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "e1000000-0000-4000-8000-0000000000a1";
const MILESTONE = "e1000000-0000-4000-8000-0000000000a2";

const query = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
};

/** Two days ago: always a past date, whatever the demo clock or the browser's time zone. */
const twoDaysAgo = (): string => new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

test("recording a bank transfer on an overdue invoice marks it paid and stops its reminders", async ({
  page,
}) => {
  await query("DELETE FROM public.projects WHERE id = $1", [PROJECT]);
  await query(
    `INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
     VALUES ($1, $2, $3, 'Shop checkout', 60000, 'USD', '2026-12-31')`,
    [PROJECT, DEMO_USER_ID, CLIENT],
  );
  await query(
    `INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode, status)
     VALUES ($1, $2, $3, 'USD', 1, 'Checkout', 10000, '2026-12-01', 'pay_on_invoice', 'delivered')`,
    [MILESTONE, DEMO_USER_ID, PROJECT],
  );
  try {
    const issued = await page.request.post(`/api/milestones/${MILESTONE}/invoice`, { data: {} });
    expect(issued.status(), await issued.text()).toBe(201);
    await query("UPDATE public.invoices SET due_date = '2026-10-01' WHERE milestone_id = $1", [
      MILESTONE,
    ]);
    await query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
       SELECT $1, id, 'tier1', now() + interval '30 days' FROM public.invoices WHERE milestone_id = $2`,
      [DEMO_USER_ID, MILESTONE],
    );

    await page.goto(`/projects/${PROJECT}`, { waitUntil: "networkidle" });
    const card = page.getByRole("article", { name: "Checkout" });
    await expect(card.getByText(/Overdue \d+d/)).toBeVisible();
    await card.getByRole("button", { name: "Record a payment" }).click();

    const form = card.getByRole("group", { name: /Record a payment for FPR-/ });
    await expect(form.getByLabel("Method")).toHaveValue("bank_transfer");
    await expect(form.getByLabel(/Amount \(USD\)/)).toHaveValue("600.00");
    await form.getByLabel("Date received").fill(twoDaysAgo());
    await form.getByLabel(/Reference/).fill("NEFT 884211");
    await form.getByRole("button", { name: "Review" }).click();

    const confirm = card.getByRole("group", { name: "Confirm the payment" });
    await expect(confirm).toContainText(/Record USD\s600\.00 by Bank transfer/);
    await expect(confirm).toContainText("its PayPal pay link stops taking payment");
    await confirm.getByRole("button", { name: "Confirm and record" }).click();

    await expect(card.locator(".badge-paid").first()).toBeVisible();
    await expect(page.locator(".paid-stamp").first()).toBeVisible();
    await expect(card.getByRole("button", { name: "Record a payment" })).toHaveCount(0);

    const [reminder] = await query<{ approval_status: string }>(
      "SELECT r.approval_status FROM public.reminders r JOIN public.invoices i ON i.id = r.invoice_id WHERE i.milestone_id = $1",
      [MILESTONE],
    );
    expect(reminder?.approval_status).toBe("skipped");
    const [payment] = await query<{ method: string; amount_cents: string; reference: string }>(
      "SELECT p.method, p.amount_cents::text, p.reference FROM public.invoice_payments p JOIN public.invoices i ON i.id = p.invoice_id WHERE i.milestone_id = $1",
      [MILESTONE],
    );
    expect(payment).toEqual({
      method: "bank_transfer",
      amount_cents: "60000",
      reference: "NEFT 884211",
    });

    await page.goto(`/clients/${CLIENT}`, { waitUntil: "networkidle" });
    await expect(
      page.getByText(/Payment recorded by you · Bank transfer · USD\s600\.00/),
    ).toBeVisible();
  } finally {
    await query("DELETE FROM public.projects WHERE id = $1", [PROJECT]);
  }
});
