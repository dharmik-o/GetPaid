import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db, type UserDbRunner } from "@/lib/db";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { loadMetrics } from "@/lib/metrics";
import { milestoneHandlers } from "@/lib/milestone-handlers";
import { createPaypalClient, PAYPAL_SANDBOX_BASE } from "@/lib/paypal";
import { projectHandlers } from "@/lib/project-handlers";
import { listProjects, listProjectsForClient } from "@/lib/projects";
import { retainerHandlers } from "@/lib/retainer-handlers";
import { runAsService } from "@/lib/service-db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";
import { TEST_LAWS } from "../fixtures/statutes";

// E2: archive, restore and delete a project; delete one milestone or one retainer. Real
// migrations and RLS (PGlite), PayPal mocked by msw. If any PayPal call fails, nothing is deleted.

let handle: TestDatabase;
let fake: FakePaypal;
const server = setupServer();
const box = createSecretBox(randomBytes(32));

const NOW = new Date("2026-11-03T15:00:00Z");
const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000000b2";
const EXTRA = "aaaaaaaa-0000-4000-8000-0000000000b3";
const TITLE = "Website redesign";
const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

const paypal = () => createPaypalClient(CREDENTIALS);
const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const projects = (userId = USER_A.userId) =>
  projectHandlers({
    runAsUser: runnerFor(userId),
    deleting: () => ({
      runAsUser: runnerFor(userId),
      paypal: paypal(),
      now: NOW,
      userId,
      holds: {
        runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
        runAsUser: (id: string) => runnerFor(id),
        box: () => box,
        now: () => NOW,
        laws: TEST_LAWS,
        paypal,
      },
    }),
  });

const request = (method: string, body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const remove = (body: unknown, userId = USER_A.userId, id = PROJECT) =>
  projects(userId).remove(request("DELETE", body), ctx(id));

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const errorOf = async (response: Response): Promise<string> =>
  (await json<{ error?: string; errors?: { field: string; message: string }[] }>(response)).error ??
  "";

const count = async (table: string, where = "TRUE"): Promise<number> =>
  Number(
    (
      await handle.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.${table} WHERE ${where}`,
      )
    ).rows[0]?.n,
  );

const projectExists = async (id = PROJECT): Promise<boolean> =>
  (await count("projects", `id = '${id}'`)) === 1;

/** A sent PayPal invoice for the Build milestone. */
const sendInvoice = async (): Promise<{ id: string; paypalId: string }> => {
  const response = await invoiceHandlers({
    runAsUser: runnerFor(USER_A.userId),
    paypal,
    now: () => NOW,
  }).issue(request("POST", {}), ctx(BUILD));
  expect(response.status).toBe(201);
  const id = (await json<{ invoices: { id: string }[] }>(response)).invoices[0]?.id ?? "";
  const row = await handle.db.query<{ paypal_invoice_id: string }>(
    "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
    [id],
  );
  return { id, paypalId: row.rows[0]?.paypal_invoice_id ?? "" };
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  await handle.db.query(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
  await handle.db.query(`
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', '${TITLE}', 300000, 'USD', '2026-12-31');
    INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode, status)
      VALUES ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'Build', 7000, '2026-12-10', 'pay_on_invoice', 'delivered'),
             ('${EXTRA}', '${USER_A.userId}', '${PROJECT}', 'USD', 2, 'Extras', 3000, '2026-12-20', 'pay_on_invoice', 'planned');
  `);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("DELETE /api/projects/[id]", () => {
  it("needs the project's exact name, and deletes nothing without it", async () => {
    for (const confirmName of ["", "website redesign", `${TITLE} `, "Other"]) {
      const response = await remove({ confirmName });
      expect(response.status).toBe(400);
      const { errors } = await json<{ errors: { field: string }[] }>(response);
      expect(errors[0]?.field).toBe("confirmName");
    }
    expect((await remove({})).status).toBe(400);
    expect(await projectExists()).toBe(true);
  });

  it("answers 404 for another user's project and for a malformed id", async () => {
    expect((await remove({ confirmName: TITLE }, USER_B.userId)).status).toBe(404);
    expect((await remove({ confirmName: TITLE }, USER_A.userId, "not-a-uuid")).status).toBe(404);
    expect(await projectExists()).toBe(true);
  });

  it("removes the project with its milestones, invoices, reminders, agreements, holds, jobs and calendar items", async () => {
    // The seeded project has all of these (fixtures.ts); one calendar entry is tied to it.
    const seeded = USER_A.rows.projects;
    await handle.db.query("UPDATE public.invoices SET status = 'paid' WHERE id = $1", [
      USER_A.rows.invoices,
    ]);
    await handle.db.query("UPDATE public.calendar_entries SET project_id = $1 WHERE id = $2", [
      seeded,
      USER_A.rows.calendar_entries,
    ]);
    const before = {
      milestones: await count("milestones", `project_id = '${seeded}'`),
      agreements: await count("agreements", `project_id = '${seeded}'`),
      maintenance: await count("maintenance_tasks", `project_id = '${seeded}'`),
    };
    expect(before).toEqual({ milestones: 1, agreements: 1, maintenance: 1 });

    const response = await remove({ confirmName: "Website redesign" }, USER_A.userId, seeded);
    expect(response.status).toBe(200);
    expect(await projectExists(seeded)).toBe(false);
    for (const [table, where] of [
      ["milestones", `project_id = '${seeded}'`],
      ["agreements", `project_id = '${seeded}'`],
      ["maintenance_tasks", `project_id = '${seeded}'`],
      ["invoices", `id = '${USER_A.rows.invoices}'`],
      ["reminders", `invoice_id = '${USER_A.rows.invoices}'`],
      ["messages", `invoice_id = '${USER_A.rows.invoices}'`],
      ["milestone_holds", `id = '${USER_A.rows.milestone_holds}'`],
      ["invoice_archive_files", `invoice_id = '${USER_A.rows.invoices}'`],
      ["calendar_entries", `id = '${USER_A.rows.calendar_entries}'`],
    ] as const) {
      expect(await count(table, where), table).toBe(0);
    }
    // Another user's rows are untouched.
    expect(await projectExists(USER_B.rows.projects)).toBe(true);
    expect(await count("invoices", `id = '${USER_B.rows.invoices}'`)).toBe(1);
  });

  it("lists unpaid invoices and refuses until the box is ticked; nothing reaches PayPal", async () => {
    const { paypalId } = await sendInvoice();
    const calls = fake.calls.length;
    const response = await remove({ confirmName: TITLE });
    expect(response.status).toBe(409);
    const message = await errorOf(response);
    expect(message).toMatch(/unpaid invoices: FPR-\d+ · Build/);
    expect(message).toContain("Cancel them in PayPal too");
    expect(fake.calls).toHaveLength(calls);
    expect(fake.invoices.get(paypalId)?.status).toBe("UNPAID");
    expect(await projectExists()).toBe(true);
  });

  it("cancels the unpaid invoices in PayPal first when the box is ticked, then deletes", async () => {
    const { paypalId } = await sendInvoice();
    const response = await remove({ confirmName: TITLE, cancelOpen: true });
    expect(response.status).toBe(200);
    expect(fake.invoices.get(paypalId)?.status).toBe("CANCELLED");
    expect(await projectExists()).toBe(false);
    expect(await count("invoices", `milestone_id = '${BUILD}'`)).toBe(0);
  });

  it("deletes nothing when PayPal refuses the cancel", async () => {
    const { id } = await sendInvoice();
    server.use(
      http.post(`${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id/cancel`, () =>
        HttpResponse.json(
          { name: "INTERNAL_SERVER_ERROR", debug_id: "fake", details: [{ issue: "BROKEN" }] },
          { status: 500 },
        ),
      ),
    );
    const response = await remove({ confirmName: TITLE, cancelOpen: true });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toContain("Nothing was deleted");
    expect(await projectExists()).toBe(true);
    expect(await count("invoices", `id = '${id}'`)).toBe(1);
    expect(await count("milestones", `project_id = '${PROJECT}'`)).toBe(2);
  });

  it("deletes nothing when an invoice already has money on it", async () => {
    const { id, paypalId } = await sendInvoice();
    fake.pay(paypalId, "100.00", "PARTIALLY_PAID");
    await handle.db.query(
      "UPDATE public.invoices SET status = 'partially_paid', amount_paid_cents = 10000 WHERE id = $1",
      [id],
    );
    const response = await remove({ confirmName: TITLE, cancelOpen: true });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatch(/already has money on it/);
    expect(await projectExists()).toBe(true);
  });

  it("voids an open hold first, and deletes", async () => {
    await handle.db.query(
      `INSERT INTO public.milestone_holds (user_id, milestone_id, amount_cents, currency, status)
       VALUES ('${USER_A.userId}', '${EXTRA}', 90000, 'USD', 'pending_approval')`,
    );
    const refused = await remove({ confirmName: TITLE });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toContain("open holds: Extras");
    const response = await remove({ confirmName: TITLE, cancelOpen: true });
    expect(response.status).toBe(200);
    expect(await projectExists()).toBe(false);
    expect(await count("milestone_holds", `milestone_id = '${EXTRA}'`)).toBe(0);
  });
});

describe("archive and restore", () => {
  const archive = (userId = USER_A.userId) =>
    projects(userId).archive(request("POST"), ctx(PROJECT));
  const restore = () => projects().restore(request("POST"), ctx(PROJECT));
  const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, USER_A.userId, work);

  it("hides the project from lists, keeps its records, and brings it back on restore", async () => {
    expect((await asA((db) => listProjects(db))).map((p) => p.id)).toContain(PROJECT);
    expect((await archive()).status).toBe(200);
    expect((await asA((db) => listProjects(db))).map((p) => p.id)).not.toContain(PROJECT);
    const shown = await asA((db) => listProjects(db, { includeArchived: true }));
    expect(shown.find((p) => p.id === PROJECT)).toMatchObject({ archived: true });
    expect(
      (await asA((db) => listProjectsForClient(db, USER_A.rows.clients))).map((p) => p.id),
    ).not.toContain(PROJECT);
    expect(await count("milestones", `project_id = '${PROJECT}'`)).toBe(2);

    expect((await restore()).status).toBe(200);
    expect((await asA((db) => listProjects(db))).map((p) => p.id)).toContain(PROJECT);
  });

  it("stops the waiting reminders, and keeps the invoices out of Home's figures", async () => {
    const { id } = await sendInvoice();
    await handle.db.query("UPDATE public.invoices SET due_date = '2026-10-01' WHERE id = $1", [id]);
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
       VALUES ($1, $2, 'tier1', '2026-11-04T14:00:00Z')`,
      [USER_A.userId, id],
    );
    const overdueBefore = (await asA((db) => loadMetrics(db, NOW))).overdue;
    await archive();
    const reminder = await handle.db.query<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE invoice_id = $1",
      [id],
    );
    expect(reminder.rows[0]?.approval_status).toBe("skipped");
    const overdueAfter = (await asA((db) => loadMetrics(db, NOW))).overdue;
    expect(JSON.stringify(overdueAfter).length).toBeLessThan(JSON.stringify(overdueBefore).length);
    expect(JSON.stringify(overdueAfter)).not.toContain(id);
    expect(await count("invoices", `id = '${id}'`)).toBe(1);
  });

  it("answers 404 for another user's project", async () => {
    expect((await archive(USER_B.userId)).status).toBe(404);
    expect(await count("projects", `id = '${PROJECT}' AND archived_at IS NOT NULL`)).toBe(0);
  });
});

describe("DELETE /api/milestones/[id]", () => {
  const del = (id: string, userId = USER_A.userId) =>
    milestoneHandlers({ runAsUser: runnerFor(userId) }).remove(request("DELETE"), ctx(id));

  it("deletes a milestone that has no invoice, and nothing else", async () => {
    expect((await del(EXTRA)).status).toBe(200);
    expect(await count("milestones", `project_id = '${PROJECT}'`)).toBe(1);
    expect(await projectExists()).toBe(true);
  });

  it("refuses once the milestone has an invoice, even a cancelled one, or a hold", async () => {
    const { id } = await sendInvoice();
    expect((await del(BUILD)).status).toBe(409);
    await handle.db.query("UPDATE public.invoices SET status = 'cancelled' WHERE id = $1", [id]);
    const cancelled = await del(BUILD);
    expect(cancelled.status).toBe(409);
    expect(await errorOf(cancelled)).toMatch(/invoice on record/);
    await handle.db.query(
      `INSERT INTO public.milestone_holds (user_id, milestone_id, amount_cents, currency, status)
       VALUES ('${USER_A.userId}', '${EXTRA}', 90000, 'USD', 'voided')`,
    );
    expect((await del(EXTRA)).status).toBe(409);
    expect(await count("milestones", `project_id = '${PROJECT}'`)).toBe(2);
  });

  it("answers 404 for another user's milestone", async () => {
    expect((await del(EXTRA, USER_B.userId)).status).toBe(404);
    expect(await count("milestones", `id = '${EXTRA}'`)).toBe(1);
  });
});

describe("DELETE /api/retainers/[id]", () => {
  const RETAINER = "aaaaaaaa-0000-4000-8000-0000000000e1";
  const del = (id: string, userId = USER_A.userId) =>
    retainerHandlers({
      currentUser: () => userId,
      runAsCurrent: runnerFor(userId),
      runAsUser: (id2: string) => runnerFor(id2),
      box: () => box,
      now: () => NOW,
      laws: TEST_LAWS,
      paypal,
    }).remove(request("DELETE"), ctx(id));

  beforeEach(async () => {
    await handle.db.query(`DELETE FROM public.retainers WHERE id = '${RETAINER}'`);
    await handle.db.query(
      `INSERT INTO public.retainers (id, user_id, client_id, name, amount_cents, currency, interval_unit, starts_on, method)
       VALUES ('${RETAINER}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Hosting', 5000, 'USD', 'month', '2026-12-01', 'invoice')`,
    );
  });

  it("deletes a retainer that never charged", async () => {
    expect((await del(RETAINER)).status).toBe(204);
    expect(await count("retainers", `id = '${RETAINER}'`)).toBe(0);
  });

  it("refuses one with an invoice, a payment, or auto-pay still set up", async () => {
    await handle.db.query(
      `INSERT INTO public.invoices (user_id, retainer_id, amount_cents, currency, due_date, retainer_cycle_on, retainer_cycle_reason)
       VALUES ('${USER_A.userId}', '${RETAINER}', 5000, 'USD', '2026-12-08', '2026-12-01', 'cycle')`,
    );
    expect((await del(RETAINER)).status).toBe(409);
    await handle.db.query("DELETE FROM public.invoices WHERE retainer_id = $1", [RETAINER]);
    await handle.db.query(
      "UPDATE public.retainers SET paypal_subscription_id = 'I-SUB', status = 'active' WHERE id = $1",
      [RETAINER],
    );
    expect((await del(RETAINER)).status).toBe(409);
    await handle.db.query("UPDATE public.retainers SET status = 'cancelled' WHERE id = $1", [
      RETAINER,
    ]);
    expect((await del(RETAINER)).status).toBe(204);
  });

  it("answers 404 for another user's retainer", async () => {
    expect((await del(RETAINER, USER_B.userId)).status).toBe(404);
    expect(await count("retainers", `id = '${RETAINER}'`)).toBe(1);
  });
});
