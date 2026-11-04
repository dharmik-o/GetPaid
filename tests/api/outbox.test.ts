import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { listOutbox, outboxCounts } from "@/lib/outbox";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { storedDraftSchema, type StoredDraft } from "@/lib/stored-draft";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";

// The Outbox routes and list: real migrations and RLS (PGlite). No network.

let handle: TestDatabase;

const { reminders: REMINDER, invoices: INVOICE } = USER_A.rows;
const OTHER_REMINDER = USER_B.rows.reminders;
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-OUTB-TEST-0001";
/** A Tuesday, 15:00 in New York: inside the default send window. */
const NOW = new Date("2026-12-22T20:00:00Z");

const DRAFT: StoredDraft = {
  subject: "Invoice FPR-1 is overdue",
  body: `Hello, please pay here: ${PAY_LINK}`,
  kind: "tier1",
  via: "template",
  model: null,
  isLocal: null,
  citation: null,
  lawId: null,
  notLegalAdvice: false,
  draftedAt: "2026-12-22T14:00:00.000Z",
};

const asUserA = <T>(work: (db: Db) => Promise<T>): Promise<T> =>
  runAsUser(handle.db, USER_A.userId, work);

const handlers = () => outboxHandlers({ runAsUser: asUserA, now: () => NOW, laws: TEST_LAWS });

const act = (id: string, payload: unknown) =>
  handlers().post(
    new Request(`http://127.0.0.1:3000/api/outbox/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );

const row = async (id = REMINDER) => {
  const { rows } = await handle.db.query<{
    approval_status: string;
    approved_via: string | null;
    scheduled_at: Date;
    draft: (StoredDraft & { editedAt?: string }) | null;
  }>(
    "SELECT approval_status, approved_via, scheduled_at, draft FROM public.reminders WHERE id = $1",
    [id],
  );
  const found = rows[0];
  if (!found) throw new Error(`No reminder ${id} in the test database.`);
  return found;
};

const eventTypes = async () => {
  const { rows } = await handle.db.query<{ type: string }>(
    "SELECT type FROM public.events WHERE entity = 'reminder' AND entity_id = $1 ORDER BY created_at",
    [REMINDER],
  );
  return rows.map((event) => event.type);
};

const setReminder = (sql: string) =>
  handle.db.query(`UPDATE public.reminders SET ${sql} WHERE id = '${REMINDER}'`);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(`UPDATE public.invoices SET status = 'sent', link = $1`, [PAY_LINK]);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query(
    `UPDATE public.reminders SET approval_status = 'waiting', approved_via = NULL, sent_at = NULL,
       scheduled_at = '2026-12-23T15:00:00Z', draft = $1`,
    [JSON.stringify(DRAFT)],
  );
  await handle.db.query(`UPDATE public.users SET time_zone = 'Asia/Kolkata'`);
  await handle.db.query(`DELETE FROM public.events WHERE entity = 'reminder'`);
  await handle.db.query(`UPDATE public.invoices SET status = 'sent', amount_paid_cents = 0`);
});

describe("Outbox list", () => {
  const list = (tab: "waiting" | "scheduled" | "sent" | "skipped") =>
    asUserA((db) => listOutbox(db, tab, NOW));

  it("shows a waiting draft with both time zones, the amount due and the message", async () => {
    await handle.db.query(
      `UPDATE public.invoices SET amount_paid_cents = 10000 WHERE id = '${INVOICE}'`,
    );
    const [item] = await list("waiting");
    expect(item).toMatchObject({
      id: REMINDER,
      clientName: "Client a",
      tier: "tier1",
      payLink: PAY_LINK,
    });
    expect(item?.what).toContain("Website redesign · Design");
    expect(item?.amountDue).toContain("800.00");
    expect(item?.draft?.body).toContain(PAY_LINK);
    // 15:00 UTC is 10:00 in New York and 20:30 in Kolkata.
    expect(item?.sendTime).toContain("10:00 client time (America/New_York)");
    expect(item?.sendTime).toContain("20:30 yours (Asia/Kolkata)");
  });

  it("leaves out reminders with no draft yet, and other users' drafts", async () => {
    await setReminder("draft = NULL");
    expect(await list("waiting")).toEqual([]);
  });

  it("shows a past planned time as the next time it can really go out", async () => {
    // Planned for Monday; it's now Tuesday 15:00 in New York, so it can go right away.
    await setReminder("scheduled_at = '2026-12-21T15:00:00Z'");
    const [item] = await list("waiting");
    expect(item?.sendTime).toContain("15:00 client time");
  });

  it("files each state under its own tab, and counts only the user's own", async () => {
    expect(await asUserA((db) => outboxCounts(db))).toMatchObject({ waiting: 1, scheduled: 0 });
    await setReminder("approval_status = 'approved', approved_via = 'outbox'");
    expect(await list("waiting")).toEqual([]);
    expect((await list("scheduled")).map((i) => i.id)).toEqual([REMINDER]);
    await setReminder("sent_at = '2026-12-22T15:00:00Z'");
    expect(await list("scheduled")).toEqual([]);
    expect((await list("sent")).map((i) => i.id)).toEqual([REMINDER]);
    await setReminder("approval_status = 'skipped', approved_via = NULL, sent_at = NULL");
    expect((await list("skipped")).map((i) => i.id)).toEqual([REMINDER]);
  });

  it("marks a stored draft that fails the schema, and it can't be approved", async () => {
    await setReminder(`draft = '{"subject": "broken"}'`);
    const [item] = await list("waiting");
    expect(item?.draft).toBeNull();
    const response = await act(REMINDER, { action: "approve" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("failed its checks");
    expect((await row()).approval_status).toBe("waiting");
  });
});

describe("Approve", () => {
  it("approves a waiting draft once and records it", async () => {
    expect((await act(REMINDER, { action: "approve" })).status).toBe(200);
    expect(await row()).toMatchObject({ approval_status: "approved", approved_via: "outbox" });
    expect(await eventTypes()).toEqual(["reminder.approved"]);
  });

  it("answers 409 on a double approve and records nothing more", async () => {
    await act(REMINDER, { action: "approve" });
    const second = await act(REMINDER, { action: "approve" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain("already handled");
    expect(await eventTypes()).toEqual(["reminder.approved"]);
  });

  it("refuses a draft whose invoice can no longer be paid", async () => {
    await handle.db.query(`UPDATE public.invoices SET status = 'paid' WHERE id = '${INVOICE}'`);
    expect((await act(REMINDER, { action: "approve" })).status).toBe(409);
    expect((await row()).approval_status).toBe("waiting");
  });

  it("can't touch another user's draft", async () => {
    expect((await act(OTHER_REMINDER, { action: "approve" })).status).toBe(404);
    expect((await row(OTHER_REMINDER)).approval_status).toBe("waiting");
  });

  it("answers 404 for a bad id and for a reminder with no draft yet", async () => {
    expect((await act("nope", { action: "approve" })).status).toBe(404);
    await setReminder("draft = NULL");
    expect((await act(REMINDER, { action: "approve" })).status).toBe(404);
  });
});

describe("Skip", () => {
  it("skips a waiting draft", async () => {
    expect((await act(REMINDER, { action: "skip" })).status).toBe(200);
    expect((await row()).approval_status).toBe("skipped");
    expect(await eventTypes()).toEqual(["reminder.skipped"]);
  });

  it("stops an approved draft that hasn't gone out", async () => {
    await act(REMINDER, { action: "approve" });
    expect((await act(REMINDER, { action: "skip" })).status).toBe(200);
    expect(await row()).toMatchObject({ approval_status: "skipped", approved_via: null });
  });

  it("can't skip what was already sent", async () => {
    await setReminder(
      "approval_status = 'approved', approved_via = 'outbox', sent_at = '2026-12-22T15:00:00Z'",
    );
    expect((await act(REMINDER, { action: "skip" })).status).toBe(409);
  });
});

describe("Edit", () => {
  const edit = (subject: string, body: string) => act(REMINDER, { action: "edit", subject, body });

  it("saves a checked edit, keeps it waiting and marks it edited", async () => {
    const response = await edit("A softer subject", `Thanks for your patience. ${PAY_LINK}`);
    expect(response.status).toBe(200);
    const saved = await row();
    expect(saved.approval_status).toBe("waiting");
    expect(saved.draft).toMatchObject({
      subject: "A softer subject",
      body: `Thanks for your patience. ${PAY_LINK}`,
      editedAt: NOW.toISOString(),
    });
    expect(await eventTypes()).toEqual(["reminder.edited"]);
  });

  it("an edited draft still passes the schema, shows on its card and can be approved", async () => {
    await edit("A softer subject", `Thanks for your patience. ${PAY_LINK}`);
    expect(storedDraftSchema.safeParse((await row()).draft).success).toBe(true);
    const [item] = await asUserA((db) => listOutbox(db, "waiting", NOW));
    expect(item?.draft?.subject).toBe("A softer subject");
    expect((await act(REMINDER, { action: "approve" })).status).toBe(200);
  });

  it.each([
    ["no pay link", "Please pay soon.", /pay link/],
    ["another link", `Pay at ${PAY_LINK} or https://evil.example/pay`, /other than the pay link/],
    ["an invented amount", `Pay USD 99,999.00 at ${PAY_LINK}`, /amount/],
    [
      "a law it may not cite",
      `Under the Late Payment of Commercial Debts Act 1998 you owe interest. ${PAY_LINK}`,
      /cit|law|legal/i,
    ],
  ])("refuses an edit with %s", async (_name, body, message) => {
    const response = await edit("Subject", body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
    expect((await row()).draft?.body).toBe(DRAFT.body);
  });

  it("refuses an empty message and a subject with a line break", async () => {
    expect((await edit("Subject", "")).status).toBe(400);
    expect((await edit("Two\nlines", `Pay: ${PAY_LINK}`)).status).toBe(400);
  });

  it("can't edit a draft that was already approved", async () => {
    await act(REMINDER, { action: "approve" });
    expect((await edit("Changed", `Pay: ${PAY_LINK}`)).status).toBe(409);
    expect((await row()).draft?.subject).toBe(DRAFT.subject);
  });
});

describe("Reschedule", () => {
  const reschedule = (at: string) => act(REMINDER, { action: "reschedule", at });

  it("reads the new time in the client's zone and keeps the approval as it was", async () => {
    // 11:30 in New York on 28 Dec (a Monday) is 16:30 UTC.
    expect((await reschedule("2026-12-28T11:30")).status).toBe(200);
    const saved = await row();
    expect(saved.scheduled_at.toISOString()).toBe("2026-12-28T16:30:00.000Z");
    expect(saved.approval_status).toBe("waiting");
    expect(await eventTypes()).toEqual(["reminder.rescheduled"]);
  });

  it("moves a time outside the send window to the next opening", async () => {
    // Saturday 26 Dec: the window opens Monday 09:00 New York.
    expect((await reschedule("2026-12-26T11:30")).status).toBe(200);
    expect((await row()).scheduled_at.toISOString()).toBe("2026-12-28T14:00:00.000Z");
  });

  it("refuses a time in the past, and a time that isn't one", async () => {
    expect((await reschedule("2026-12-21T11:30")).status).toBe(400);
    expect((await reschedule("next week")).status).toBe(400);
    expect((await row()).scheduled_at.toISOString()).toBe("2026-12-23T15:00:00.000Z");
  });

  it("can move an approved draft, but not a sent or skipped one", async () => {
    await act(REMINDER, { action: "approve" });
    expect((await reschedule("2026-12-28T11:30")).status).toBe(200);
    expect((await row()).approval_status).toBe("approved");
    await act(REMINDER, { action: "skip" });
    expect((await reschedule("2026-12-29T11:30")).status).toBe(409);
  });
});

describe("Bad requests", () => {
  it("rejects an unknown action", async () => {
    expect((await act(REMINDER, { action: "send_now" })).status).toBe(400);
  });

  it("rejects extra fields that try to set the outcome", async () => {
    expect((await act(REMINDER, { action: "approve", approved_via: "telegram" })).status).toBe(400);
  });
});
