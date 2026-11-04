import { randomBytes } from "node:crypto";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { saveGmailConnection } from "@/lib/gmail-account";
import { listOutbox } from "@/lib/outbox";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { senderHandler } from "@/lib/sender-handler";
import { runAsService } from "@/lib/service-db";
import type { StoredDraft } from "@/lib/stored-draft";
import { telegramCardHandlers } from "@/lib/telegram-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";

// The sender: real migrations and RLS (PGlite), Gmail mocked by msw. Nothing here can reach
// Google: msw refuses any request it has no handler for.

let handle: TestDatabase;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const TOKEN = "t".repeat(64);
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-SEND-TEST-0001";
const CLIENT_A = "client-a@example.test";
const CLIENT_B = "client-b@example.test";
const CHAT_A = 7001;
/** A Wednesday, 10:00 in New York: inside the default send window. */
const NOW = new Date("2026-12-23T15:00:00Z");
let clock = NOW;
let allowlist: string[] = [CLIENT_A, CLIENT_B];
const PDF_BYTES = Buffer.from("%PDF-1.7 fake");
let pdfFails = false;

const { reminders: REMINDER, invoices: INVOICE } = USER_A.rows;

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

const asUserId =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const deps = (oauth: { clientId: string; clientSecret: string } | undefined = OAUTH) => ({
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  runAsUser: asUserId,
  now: () => clock,
  box: () => box,
  oauth: () => oauth,
  allowlist: () => new Set(allowlist),
  pdf: () =>
    pdfFails
      ? Promise.reject(new Error("no chromium"))
      : Promise.resolve({ pdf: PDF_BYTES, filename: "invoice-FPR-1.pdf" }),
  token: () => TOKEN,
});
const OAUTH = { clientId: "fake-client-id", clientSecret: "fake-client-secret" };

const internal = (url: string, body: unknown = {}) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

const run = async () => {
  const response = await senderHandler(deps()).post(internal("/api/internal/sender/run"));
  expect(response.status).toBe(200);
  return (await response.json()) as { sent: number; held: number };
};

const row = async (id = REMINDER) => {
  const { rows } = await handle.db.query<{
    approval_status: string;
    sent_at: Date | null;
    send_attempted_at: Date | null;
    send_blocked_reason: string | null;
  }>(
    `SELECT approval_status, sent_at, send_attempted_at, send_blocked_reason
     FROM public.reminders WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (!found) throw new Error(`No reminder ${id}.`);
  return found;
};

const invoice = async () => {
  const { rows } = await handle.db.query<{
    gmail_thread_id: string | null;
    gmail_thread_subject: string | null;
  }>("SELECT gmail_thread_id, gmail_thread_subject FROM public.invoices WHERE id = $1", [INVOICE]);
  return rows[0];
};

const setReminder = (sql: string, params: unknown[] = []) =>
  handle.db.query(`UPDATE public.reminders SET ${sql} WHERE id = '${REMINDER}'`, params);

/** Every reminder starts as an approved draft that's due now. */
const approve = () =>
  setReminder(
    `approval_status = 'approved', approved_via = 'outbox', scheduled_at = '2026-12-23T14:00:00Z',
     sent_at = NULL, send_attempted_at = NULL, send_blocked_reason = NULL, tier = 'tier1', draft = $1`,
    [JSON.stringify(DRAFT)],
  );

const addFollowUp = async (subject = "A different subject") => {
  await setReminder("sent_at = sent_at");
  const { rows } = await handle.db.query<{ id: string }>(
    `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, draft, approval_status, approved_via)
     VALUES ($1, $2, 'tier2', '2026-12-23T14:30:00Z', $3, 'approved', 'telegram') RETURNING id::text`,
    [USER_A.userId, INVOICE, JSON.stringify({ ...DRAFT, kind: "tier2", subject })],
  );
  return rows[0]?.id ?? "";
};

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

const log = () => vi.spyOn(process.stderr, "write").mockReturnValue(true);

beforeAll(async () => {
  gmail = createFakeGmail();
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

const connect = (userId: string) =>
  asUserId(userId)((db) =>
    saveGmailConnection(db, {
      userId,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );

beforeEach(async () => {
  clock = NOW;
  allowlist = [CLIENT_A, CLIENT_B];
  pdfFails = false;
  gmail = createFakeGmail();
  server.use(...gmail.handlers);
  await handle.db.query(`DELETE FROM public.messages WHERE gmail_message_id IS NOT NULL`);
  await handle.db.query(`DELETE FROM public.events WHERE entity = 'reminder'`);
  await handle.db.query(`DELETE FROM public.reminders WHERE id NOT IN ($1, $2)`, [
    REMINDER,
    USER_B.rows.reminders,
  ]);
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent', link = $1, amount_paid_cents = 0,
       gmail_thread_id = NULL, gmail_thread_subject = NULL`,
    [PAY_LINK],
  );
  await handle.db.query(`UPDATE public.users SET default_settings = '{}'`);
  await handle.db.query(`UPDATE public.clients SET email = 'client-a@example.test'
    WHERE user_id = '${USER_A.userId}'`);
  await handle.db.query(`UPDATE public.clients SET email = 'client-b@example.test'
    WHERE user_id = '${USER_B.userId}'`);
  await handle.db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL, sent_at = NULL,
       send_attempted_at = NULL, send_blocked_reason = NULL, telegram_message_id = NULL,
       telegram_card_closed_at = NULL, telegram_sent_notified_at = NULL, draft = $1
     WHERE id = '${USER_B.rows.reminders}'`,
    [JSON.stringify(DRAFT)],
  );
  await handle.db.query(
    `UPDATE public.users SET telegram_chat_id = CASE id WHEN '${USER_A.userId}'::uuid
       THEN ${String(CHAT_A)} END, gmail_reconnect_notified_at = NULL`,
  );
  await connect(USER_A.userId);
  await connect(USER_B.userId);
  await approve();
  await setReminder(
    "telegram_message_id = NULL, telegram_card_closed_at = NULL, telegram_sent_notified_at = NULL",
  );
});

describe("the first reminder", () => {
  it("goes from the freelancer's address to the client, with the message and the PDF", async () => {
    expect(await run()).toMatchObject({ sent: 1 });
    expect(gmail.state.sent).toHaveLength(1);
    const mail = decode(gmail.state.sent[0]?.raw ?? "");
    expect(mail).toContain(`<${FAKE_GMAIL_ADDRESS}>`);
    expect(mail).toContain(`To: "Client a" <${CLIENT_A}>`);
    expect(mail).toContain(`Subject: ${DRAFT.subject}`);
    expect(mail.replace(/\r\n/g, "")).toContain(Buffer.from(DRAFT.body, "utf8").toString("base64"));
    expect(mail).toContain("application/pdf");
    expect(mail).toContain(PDF_BYTES.toString("base64"));
  });

  it("starts the thread: no threadId, and it stores the thread, subject and Message-ID", async () => {
    await run();
    expect(gmail.state.sent[0]?.requestedThreadId).toBeUndefined();
    const stored = await invoice();
    expect(stored?.gmail_thread_id).toBe("thread-1");
    expect(stored?.gmail_thread_subject).toBe(DRAFT.subject);
    const { rows } = await handle.db.query<{
      direction: string;
      thread_id: string;
      gmail_message_id: string;
      rfc_message_id: string;
      body: string;
    }>(
      `SELECT direction, thread_id, gmail_message_id, rfc_message_id, body FROM public.messages
       WHERE invoice_id = $1 AND gmail_message_id IS NOT NULL`,
      [INVOICE],
    );
    expect(rows).toEqual([
      {
        direction: "out",
        thread_id: "thread-1",
        gmail_message_id: "sent-1",
        rfc_message_id: "<gmail-sent-1@mail.gmail.test>",
        body: DRAFT.body,
      },
    ]);
  });

  it("records the send, without the message in the event", async () => {
    await run();
    const saved = await row();
    expect(saved.sent_at?.toISOString()).toBe(NOW.toISOString());
    expect(saved.send_blocked_reason).toBeNull();
    const { rows } = await handle.db.query<{ payload: unknown }>(
      "SELECT payload FROM public.events WHERE type = 'reminder.sent' AND entity_id = $1",
      [REMINDER],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(DRAFT.body);
  });

  it("goes only once, however many times the run repeats", async () => {
    await run();
    await run();
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  it("never logs the message or a token", async () => {
    const write = log();
    await run();
    const logged = write.mock.calls.map(([line]) => String(line)).join("");
    expect(logged).not.toContain(DRAFT.body);
    expect(logged).not.toContain(FAKE_REFRESH_TOKEN);
    expect(logged).not.toContain(CLIENT_A);
  });
});

describe("a follow-up", () => {
  it("stays on the thread: threadId, In-Reply-To, References and the same subject", async () => {
    await run();
    const followUp = await addFollowUp();
    expect(await run()).toMatchObject({ sent: 1 });
    expect((await row(followUp)).sent_at).not.toBeNull();
    const second = gmail.state.sent[1];
    expect(second?.requestedThreadId).toBe("thread-1");
    const mail = decode(second?.raw ?? "");
    expect(mail).toContain(`Subject: ${DRAFT.subject}`);
    expect(mail).not.toContain("A different subject");
    expect(mail).toContain("In-Reply-To: <gmail-sent-1@mail.gmail.test>");
    expect(mail).toContain("References: <gmail-sent-1@mail.gmail.test>");
  });

  it("the third carries every earlier Message-ID, with the latest as In-Reply-To", async () => {
    await run();
    await addFollowUp();
    await run();
    await addFollowUp();
    await run();
    const mail = decode(gmail.state.sent[2]?.raw ?? "");
    expect(mail).toContain("In-Reply-To: <gmail-sent-2@mail.gmail.test>");
    expect(mail).toMatch(
      /References: <gmail-sent-1@mail\.gmail\.test>\s+<gmail-sent-2@mail\.gmail\.test>/,
    );
    expect(gmail.state.sent[2]?.requestedThreadId).toBe("thread-1");
  });

  it("keeps our own Message-ID if Gmail can't be asked for its one", async () => {
    gmail.state.messageLookupFails = true;
    await run();
    expect((await row()).sent_at).not.toBeNull();
    const { rows } = await handle.db.query<{ rfc_message_id: string }>(
      "SELECT rfc_message_id FROM public.messages WHERE gmail_message_id = 'sent-1'",
    );
    expect(rows[0]?.rfc_message_id).toMatch(/^<.+@.+>$/);
  });
});

describe("only approved drafts go", () => {
  it.each([
    ["waiting", "approval_status = 'waiting', approved_via = NULL"],
    ["skipped", "approval_status = 'skipped', approved_via = NULL"],
  ])("a %s draft never sends", async (_name, sql) => {
    await setReminder(sql);
    expect(await run()).toMatchObject({ sent: 0 });
    expect(gmail.state.sent).toEqual([]);
  });

  it("a Tier 3 draft waiting for a person never sends, whatever the approval mode", async () => {
    await handle.db.query(
      `UPDATE public.users SET default_settings = '{"approvalMode": "auto_send_tier1"}'`,
    );
    await setReminder("approval_status = 'waiting', approved_via = NULL, tier = 'tier3'");
    await run();
    expect(gmail.state.sent).toEqual([]);
  });

  it("a stored draft that fails the schema is held, not sent", async () => {
    await setReminder(`draft = '{"subject": "broken"}'`);
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("draft_invalid");
  });

  it("a draft that lost its pay link is held, not sent", async () => {
    await setReminder("draft = $1", [JSON.stringify({ ...DRAFT, body: "No link here." })]);
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("no_pay_link");
  });

  it("a draft whose invoice was paid meanwhile is stopped, not sent", async () => {
    await handle.db.query(`UPDATE public.invoices SET status = 'paid' WHERE id = '${INVOICE}'`);
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect((await row()).approval_status).toBe("skipped");
  });
});

describe("the send window", () => {
  it("waits for the time it's scheduled for", async () => {
    await setReminder("scheduled_at = '2026-12-23T16:00:00Z'");
    await run();
    expect(gmail.state.sent).toEqual([]);
    clock = new Date("2026-12-23T16:00:00Z");
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  it("holds until the window opens, in the client's zone", async () => {
    // 04:00 in New York on the 23rd: approved and due, but outside 09:00 to 17:00.
    clock = new Date("2026-12-23T09:00:00Z");
    await setReminder("scheduled_at = '2026-12-23T08:00:00Z'");
    await run();
    expect(gmail.state.sent).toEqual([]);
    clock = new Date("2026-12-23T14:00:00Z");
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  it("doesn't send at the weekend", async () => {
    clock = new Date("2026-12-26T16:00:00Z");
    await run();
    expect(gmail.state.sent).toEqual([]);
  });

  it("a paused schedule holds it, and says why", async () => {
    await handle.db.query(`UPDATE public.users SET default_settings = '{"paused": true}'`);
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("paused");
  });

  it("a snooze holds it until that date", async () => {
    await handle.db.query(
      `UPDATE public.users SET default_settings = '{"snoozeUntil": "2026-12-28"}'`,
    );
    await run();
    expect(gmail.state.sent).toEqual([]);
    clock = new Date("2026-12-28T15:00:00Z");
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });
});

describe("the dev allowlist (security rule 8)", () => {
  it("empty means nothing sends: the reminder is held, and it's logged", async () => {
    allowlist = [];
    const write = log();
    await run();
    const logged = write.mock.calls.map(([line]) => String(line)).join("");
    expect(gmail.state.sent).toEqual([]);
    expect(gmail.state.requests).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("not_allowlisted");
    expect((await row()).approval_status).toBe("approved");
    expect(logged).toContain("sender.refused_not_allowlisted");
  });

  it("refuses an address that isn't listed, and doesn't log the address", async () => {
    allowlist = ["someone-else@example.test"];
    const write = log();
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect(write.mock.calls.map(([line]) => String(line)).join("")).not.toContain(CLIENT_A);
  });

  it("logs a refusal once, not every run", async () => {
    allowlist = [];
    const write = log();
    await run();
    await run();
    const refusals = write.mock.calls.filter(([line]) =>
      String(line).includes("sender.refused_not_allowlisted"),
    );
    expect(refusals).toHaveLength(1);
  });

  it("matches without regard to case, and sends once listed", async () => {
    allowlist = [];
    await run();
    allowlist = [CLIENT_A.toUpperCase().toLowerCase()];
    await handle.db.query(`UPDATE public.clients SET email = 'Client-A@Example.test'
      WHERE user_id = '${USER_A.userId}'`);
    await run();
    expect(gmail.state.sent).toHaveLength(1);
    expect((await row()).send_blocked_reason).toBeNull();
  });
});

describe("when Google refuses the token", () => {
  beforeEach(() => {
    gmail.state.tokenError = "invalid_grant";
  });

  const user = async () => {
    const { rows } = await handle.db.query<{
      gmail_status: string;
      gmail_token_enc: string | null;
    }>("SELECT gmail_status, gmail_token_enc FROM public.users WHERE id = $1", [USER_A.userId]);
    return rows[0];
  };

  it("marks Gmail as needing a reconnect and holds the send, never drops it", async () => {
    expect(await run()).toMatchObject({ sent: 0 });
    expect(await user()).toEqual({ gmail_status: "needs_reconnect", gmail_token_enc: null });
    expect(await row()).toMatchObject({
      approval_status: "approved",
      sent_at: null,
      send_attempted_at: null,
      send_blocked_reason: "gmail_disconnected",
    });
  });

  it("sends the held reminder once reconnected", async () => {
    await run();
    gmail.state.tokenError = undefined;
    await connect(USER_A.userId);
    expect(await run()).toMatchObject({ sent: 1 });
    expect((await row()).send_blocked_reason).toBeNull();
  });

  it("tells the freelancer on Telegram, once", async () => {
    await run();
    const pending = async () => {
      const response = await telegramCardHandlers({
        runAsService: deps().runAsService,
        now: () => clock,
        token: () => TOKEN,
        outboxUrl: () => undefined,
      }).pending(internal("/api/internal/telegram/pending"));
      return ((await response.json()) as { ops: { op: string; text?: string; chatId?: number }[] })
        .ops;
    };
    const ops = await pending();
    const notice = ops.find((op) => op.text?.includes("Reconnect"));
    expect(notice).toMatchObject({ op: "sendText", chatId: CHAT_A });
    expect(notice?.text).toContain("held");
    expect((await pending()).filter((op) => op.text?.includes("Reconnect"))).toEqual([]);
  });

  it("holds while there's no token at all, without calling Google", async () => {
    await run();
    gmail.state.requests.length = 0;
    await run();
    expect(gmail.state.requests).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("gmail_disconnected");
  });

  it("shows why on the Outbox card", async () => {
    await run();
    const [item] = await asUserId(USER_A.userId)((db) => listOutbox(db, "scheduled", clock));
    expect(item?.blockedReason).toBe("gmail_disconnected");
  });
});

describe("when a send fails", () => {
  const stuck = async () => {
    const saved = await row();
    return { attempted: saved.send_attempted_at !== null, reason: saved.send_blocked_reason };
  };

  it.each([429, 403, 400])("a clear refusal (%i) is retried on a later run", async (status) => {
    gmail.state.sendFailure = status;
    await run();
    expect(await stuck()).toEqual({ attempted: false, reason: "send_failed" });
    gmail.state.sendFailure = undefined;
    await run();
    expect(gmail.state.sent).toHaveLength(1);
    expect((await row()).send_blocked_reason).toBeNull();
  });

  it.each([
    ["a server error", 503 as const],
    ["no answer at all", "network" as const],
  ])("%s might have gone out, so it's never repeated by itself", async (_name, failure) => {
    gmail.state.sendFailure = failure;
    await run();
    expect(await stuck()).toEqual({ attempted: true, reason: "unknown_outcome" });
    gmail.state.sendFailure = undefined;
    await run();
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect((await row()).sent_at).toBeNull();
  });

  it("a send that never finished recording is flagged, not repeated", async () => {
    await setReminder("send_attempted_at = '2026-12-23T14:30:00Z'");
    await run();
    expect(await stuck()).toEqual({ attempted: true, reason: "unknown_outcome" });
    expect(gmail.state.sent).toEqual([]);
  });

  it("a send started moments ago is left alone", async () => {
    await setReminder("send_attempted_at = '2026-12-23T14:59:00Z'");
    await run();
    expect(await stuck()).toEqual({ attempted: true, reason: null });
    expect(gmail.state.sent).toEqual([]);
  });

  it("a token endpoint that doesn't answer means nothing was sent, so it retries", async () => {
    gmail.state.tokenError = "server_error";
    await run();
    expect(await stuck()).toEqual({ attempted: false, reason: "send_failed" });
  });

  it("a token endpoint with no answer at all also means nothing was sent", async () => {
    gmail.state.tokenDown = true;
    await run();
    expect(await stuck()).toEqual({ attempted: false, reason: "send_failed" });
    gmail.state.tokenDown = false;
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  it("a PDF that can't be made holds it: a reminder never goes without its PDF", async () => {
    pdfFails = true;
    await run();
    expect(gmail.state.sent).toEqual([]);
    expect(await stuck()).toEqual({ attempted: false, reason: "pdf_failed" });
    pdfFails = false;
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  const outbox = (payload: unknown) =>
    outboxHandlers({
      runAsUser: asUserId(USER_A.userId),
      now: () => clock,
      laws: TEST_LAWS,
    }).post(
      new Request(`http://127.0.0.1:3000/api/outbox/${REMINDER}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: REMINDER }) },
    );

  it("the freelancer can choose to send it again", async () => {
    gmail.state.sendFailure = 503;
    await run();
    gmail.state.sendFailure = undefined;
    expect((await outbox({ action: "retry_send" })).status).toBe(200);
    await run();
    expect(gmail.state.sent).toHaveLength(1);
  });

  it("or to stop it", async () => {
    gmail.state.sendFailure = 503;
    await run();
    expect((await outbox({ action: "skip" })).status).toBe(200);
    expect((await row()).approval_status).toBe("skipped");
  });

  it("send again is refused unless the outcome really is unknown", async () => {
    expect((await outbox({ action: "retry_send" })).status).toBe(409);
  });

  it("can't be stopped or moved while it's on its way", async () => {
    await setReminder("send_attempted_at = '2026-12-23T14:59:00Z'");
    expect((await outbox({ action: "skip" })).status).toBe(409);
    expect((await outbox({ action: "reschedule", at: "2026-12-28T11:30" })).status).toBe(409);
  });
});

describe("each freelancer's own account", () => {
  it("sends with the token of the draft's owner, and marks only theirs", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET approval_status = 'approved', approved_via = 'outbox',
         scheduled_at = '2026-12-23T14:00:00Z' WHERE id = '${USER_B.rows.reminders}'`,
    );
    expect(await run()).toMatchObject({ sent: 2 });
    const tos = gmail.state.sent.map((mail) => /^To: .*$/m.exec(decode(mail.raw))?.[0]);
    expect(tos.sort()).toEqual([`To: "Client a" <${CLIENT_A}>`, `To: "Client b" <${CLIENT_B}>`]);
  });
});

describe("the mailbox", () => {
  it("is never listed or searched: only sends and our own message are called", async () => {
    await run();
    await addFollowUp();
    await run();
    expect(gmail.state.requests.filter((r) => !r.startsWith("POST token")).sort()).toEqual(
      [
        "GET /messages/sent-1?format=metadata&metadataHeaders=Message-ID",
        "GET /messages/sent-2?format=metadata&metadataHeaders=Message-ID",
        "POST /messages/send",
        "POST /messages/send",
      ].sort(),
    );
  });
});

describe("the Telegram card after a real send", () => {
  const pending = async () => {
    const response = await telegramCardHandlers({
      runAsService: deps().runAsService,
      now: () => clock,
      token: () => TOKEN,
      outboxUrl: () => undefined,
    }).pending(internal("/api/internal/telegram/pending"));
    return (
      (await response.json()) as {
        ops: { op: string; text?: string; messageId?: number; chatId?: number }[];
      }
    ).ops;
  };

  it("changes to Sent ✓ with the time, once", async () => {
    await setReminder("telegram_message_id = 501, telegram_card_closed_at = $1", [
      NOW.toISOString(),
    ]);
    await run();
    const ops = await pending();
    const sent = ops.find((op) => op.op === "editText");
    expect(sent).toMatchObject({ chatId: CHAT_A, messageId: 501 });
    expect(sent?.text).toMatch(/^Sent ✓ /);
    expect(sent?.text).toContain("10:00 client time");
    expect(await pending()).toEqual([]);
  });

  it("isn't claimed before Gmail has taken it", async () => {
    await setReminder("telegram_message_id = 501, telegram_card_closed_at = $1", [
      NOW.toISOString(),
    ]);
    allowlist = [];
    await run();
    expect((await pending()).filter((op) => op.text?.startsWith("Sent"))).toEqual([]);
  });

  it("replaces the handled wording rather than following it, when approved in the Outbox", async () => {
    await setReminder("telegram_message_id = 501");
    await run();
    const ops = await pending();
    expect(ops.map((op) => op.text?.split(" ")[0])).toEqual(["Sent"]);
  });
});

describe("who may call", () => {
  it("refuses without the token", async () => {
    const response = await senderHandler({ ...deps(), token: () => "other" }).post(
      internal("/api/internal/sender/run"),
    );
    expect(response.status).toBe(401);
    expect(gmail.state.sent).toEqual([]);
  });

  it("holds everything when the OAuth client isn't configured", async () => {
    const response = await senderHandler({ ...deps(), oauth: () => undefined }).post(
      internal("/api/internal/sender/run"),
    );
    expect(response.status).toBe(200);
    expect(gmail.state.sent).toEqual([]);
    expect(gmail.state.requests).toEqual([]);
    expect((await row()).send_blocked_reason).toBe("gmail_disconnected");
    expect((await row()).approval_status).toBe("approved");
  });
});
