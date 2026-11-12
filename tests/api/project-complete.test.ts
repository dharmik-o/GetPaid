import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db";
import { projectHandlers } from "@/lib/project-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// E1: "Mark project complete" needs every invoice paid or cancelled and no live hold, and then
// stops the reminders still waiting. Real migrations and RLS (PGlite).

let handle: TestDatabase;

const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const MILESTONE = "aaaaaaaa-0000-4000-8000-0000000000b1";
const INVOICE = "aaaaaaaa-0000-4000-8000-0000000000c1";

const complete = (userId = USER_A.userId, id = PROJECT) =>
  projectHandlers({ runAsUser: (work) => runAsUser(handle.db, userId, work) }).complete(
    new Request("http://127.0.0.1:3000/api/x", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );

const projectStatus = async (): Promise<string> =>
  (
    await handle.db.query<{ status: string }>("SELECT status FROM public.projects WHERE id = $1", [
      PROJECT,
    ])
  ).rows[0]?.status ?? "missing";

const setInvoice = (status: string) =>
  handle.db.query("UPDATE public.invoices SET status = $2 WHERE id = $1", [INVOICE, status]);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

beforeEach(async () => {
  await handle.db.query(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
  await handle.db.query(`
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Done soon', 100000, 'USD');
    INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode)
      VALUES ('${MILESTONE}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'All', 10000, '2026-12-01', 'pay_on_invoice');
    INSERT INTO public.invoices (id, user_id, milestone_id, amount_cents, currency, due_date, status)
      VALUES ('${INVOICE}', '${USER_A.userId}', '${MILESTONE}', 100000, 'USD', '2026-12-08', 'sent');
    INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
      VALUES ('${USER_A.userId}', '${INVOICE}', 'tier1', '2026-12-09T14:00:00Z');
  `);
});

afterAll(async () => {
  await handle.close();
});

describe("POST /api/projects/[id]/complete", () => {
  it("is refused while an invoice is still open, and says so", async () => {
    const response = await complete();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/1 invoice is still open/);
    expect(await projectStatus()).toBe("active");
  });

  it("is refused while a milestone hold is live, until it is voided", async () => {
    await setInvoice("paid");
    await handle.db.query(
      `INSERT INTO public.milestone_holds (user_id, milestone_id, amount_cents, currency, status)
       VALUES ('${USER_A.userId}', '${MILESTONE}', 1000, 'USD', 'authorized')`,
    );
    const refused = await complete();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Capture or void it/);
    await handle.db.query("UPDATE public.milestone_holds SET status = 'voided'");
    expect((await complete()).status).toBe(200);
  });

  it("completes when every invoice is paid or cancelled, and stops waiting reminders", async () => {
    await setInvoice("paid");
    expect((await complete()).status).toBe(200);
    expect(await projectStatus()).toBe("completed");
    const reminder = await handle.db.query<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE invoice_id = $1",
      [INVOICE],
    );
    expect(reminder.rows[0]?.approval_status).toBe("skipped");
    expect((await complete()).status).toBe(200);
  });

  it("accepts a cancelled invoice, and answers 404 for another user's project", async () => {
    await setInvoice("cancelled");
    expect((await complete(USER_B.userId)).status).toBe(404);
    expect(await projectStatus()).toBe("active");
    expect((await complete()).status).toBe(200);
  });
});
