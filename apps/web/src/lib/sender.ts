import { randomUUID } from "node:crypto";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { notPayable } from "./drafter";
import type { GmailOAuthEnv } from "./env";
import { GmailAuthExpired, GmailError, gmailClient, type GmailClient } from "./gmail";
import { loadGmailRefreshToken, markGmailNeedsReconnect } from "./gmail-account";
import type { PdfFile } from "./invoice-pdfs";
import { errorKind, logEvent } from "./log";
import { loadReminderContext, type ReminderContext } from "./reminder-context";
import { buildReminderEmail, toGmailRaw } from "./reminder-email";
import { isInsideWindow, todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";
import { storedDraftSchema, type StoredDraft } from "./stored-draft";

// Server-only: sends approved reminders from the freelancer's own Gmail, on the invoice's thread,
// inside the client's send window. n8n's 04_sender calls this every minute. A claim is saved
// before Gmail is called and released only when the send certainly failed, so a send that might
// have gone out is never repeated by itself: the freelancer decides. Nothing is ever dropped.

export type SenderDeps = {
  runAsService: ServiceDbRunner;
  runAsUser: (userId: string) => UserDbRunner;
  now: () => Date;
  box: () => SecretBox;
  oauth: () => GmailOAuthEnv | undefined;
  /** Security rule 8: the only addresses a real send may go to in dev. */
  allowlist: () => ReadonlySet<string>;
  /** The invoice's PDF. A reminder never goes without it. */
  pdf: (userId: string, invoiceId: string) => Promise<PdfFile | undefined>;
};

export type HoldReason =
  | "gmail_disconnected"
  | "not_allowlisted"
  | "draft_invalid"
  | "no_pay_link"
  | "paused"
  | "on_hold"
  | "send_failed"
  | "pdf_failed"
  | "unknown_outcome";

const CLAIM_LIFETIME_MS = 15 * 60 * 1000;
const RUN_LIMIT = 50;
/** Enough of the chain for Gmail and mail clients; the first and the latest matter most. */
const REFERENCES_KEPT = 10;

type Ready = {
  ctx: ReminderContext;
  draft: StoredDraft;
  clientEmail: string;
  ownEmail: string;
  threadId: string | null;
  subject: string;
  references: string[];
  refreshToken: string;
};

type Step = { kind: "done" } | { kind: "held" } | { kind: "ready"; ready: Ready };

type SendRow = {
  draft: unknown;
  client_email: string;
  own_email: string | null;
  gmail_status: string;
  gmail_thread_id: string | null;
  gmail_thread_subject: string | null;
  send_blocked_reason: HoldReason | null;
};

const loadSendRow = async (db: Db, id: string): Promise<SendRow | undefined> => {
  const { rows } = await db.query<SendRow>(
    `SELECT r.draft, r.send_blocked_reason, c.email AS client_email, u.gmail_email AS own_email,
       u.gmail_status, i.gmail_thread_id, i.gmail_thread_subject
     FROM public.reminders r
     JOIN public.invoices i ON i.id = r.invoice_id
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.projects p ON p.id = m.project_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
     JOIN public.users u ON u.id = r.user_id
     WHERE r.id = $1 AND r.approval_status = 'approved' AND r.sent_at IS NULL
       AND r.send_attempted_at IS NULL`,
    [id],
  );
  return rows[0];
};

/** Why it's being held, on the reminder for the Outbox. Logged only when the reason changes. */
const hold = async (
  db: Db,
  id: string,
  reason: HoldReason,
  previous: HoldReason | null,
): Promise<Step> => {
  await db.query("UPDATE public.reminders SET send_blocked_reason = $2 WHERE id = $1", [
    id,
    reason,
  ]);
  if (reason !== previous) {
    logEvent(reason === "not_allowlisted" ? "sender.refused_not_allowlisted" : "sender.held", {
      reminderId: id,
      reason,
    });
  }
  return { kind: "held" };
};

const stop = async (db: Db, id: string, why: string): Promise<Step> => {
  await db.query(
    `UPDATE public.reminders
     SET approval_status = 'skipped', approved_via = NULL, send_blocked_reason = NULL
     WHERE id = $1`,
    [id],
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.stopped', $2)`,
    [id, JSON.stringify({ why })],
  );
  return { kind: "done" };
};

const isSnoozed = (ctx: ReminderContext, now: Date): boolean =>
  ctx.settings.snoozeUntil !== null && todayIn(now, ctx.client.timeZone) < ctx.settings.snoozeUntil;

const isHeld = ({ invoice, client }: ReminderContext, now: Date): boolean =>
  invoice.held ||
  (invoice.pausedUntil !== null && todayIn(now, client.timeZone) < invoice.pausedUntil);

/** The whole chain on this invoice's thread, oldest first. */
const loadReferences = async (db: Db, threadId: string | null): Promise<string[]> => {
  if (!threadId) return [];
  const { rows } = await db.query<{ rfc_message_id: string }>(
    `SELECT rfc_message_id FROM public.messages
     WHERE thread_id = $1 AND rfc_message_id IS NOT NULL ORDER BY created_at, id`,
    [threadId],
  );
  const all = rows.map((row) => row.rfc_message_id);
  return all.length <= REFERENCES_KEPT
    ? all
    : [...all.slice(0, 1), ...all.slice(-(REFERENCES_KEPT - 1))];
};

/** Every check before Gmail, then the claim, in one transaction as the freelancer (RLS). */
const prepare = async (deps: SenderDeps, db: Db, id: string, now: Date): Promise<Step> => {
  const row = await loadSendRow(db, id);
  const ctx = row ? await loadReminderContext(db, id) : undefined;
  if (!row || !ctx) return { kind: "done" };
  const previous = row.send_blocked_reason;
  const held = (reason: HoldReason) => hold(db, id, reason, previous);

  const unpayable = notPayable(ctx);
  if (unpayable) return stop(db, id, unpayable);
  const draft = storedDraftSchema.safeParse(row.draft);
  if (!draft.success) return held("draft_invalid");
  if (!ctx.invoice.link || !draft.data.body.includes(ctx.invoice.link)) {
    return held("no_pay_link");
  }
  if (ctx.settings.paused || isSnoozed(ctx, now)) return held("paused");
  if (isHeld(ctx, now)) return held("on_hold");
  const oauth = deps.oauth();
  const refreshToken =
    oauth && row.gmail_status === "connected" && row.own_email
      ? await loadGmailRefreshToken(db, deps.box())
      : undefined;
  if (!refreshToken || !row.own_email) return held("gmail_disconnected");
  if (!deps.allowlist().has(row.client_email.trim().toLowerCase())) return held("not_allowlisted");
  if (!isInsideWindow(now, ctx.settings.sendWindow, ctx.client.timeZone)) {
    if (previous) {
      await db.query("UPDATE public.reminders SET send_blocked_reason = NULL WHERE id = $1", [id]);
    }
    return { kind: "held" };
  }

  const { rowCount } = await db.query(
    `UPDATE public.reminders SET send_attempted_at = $2, send_blocked_reason = NULL
     WHERE id = $1 AND approval_status = 'approved' AND sent_at IS NULL
       AND send_attempted_at IS NULL`,
    [id, now.toISOString()],
  );
  if (rowCount === 0) return { kind: "done" };
  return {
    kind: "ready",
    ready: {
      ctx,
      draft: draft.data,
      clientEmail: row.client_email,
      ownEmail: row.own_email,
      threadId: row.gmail_thread_id,
      // Gmail keeps a message on a thread only with the same subject.
      subject: row.gmail_thread_subject ?? draft.data.subject,
      references: await loadReferences(db, row.gmail_thread_id),
      refreshToken,
    },
  };
};

const release = (deps: SenderDeps, userId: string, id: string, reason: HoldReason) =>
  deps.runAsUser(userId)(async (db) => {
    await db.query(
      `UPDATE public.reminders SET send_attempted_at = NULL, send_blocked_reason = $2 WHERE id = $1`,
      [id, reason],
    );
  });

const flagUnknown = (deps: SenderDeps, userId: string, id: string) =>
  deps.runAsUser(userId)(async (db) => {
    await db.query(
      "UPDATE public.reminders SET send_blocked_reason = 'unknown_outcome' WHERE id = $1",
      [id],
    );
  });

const recordSent = (
  deps: SenderDeps,
  userId: string,
  id: string,
  ready: Ready,
  sent: { id: string; threadId: string },
  rfcMessageId: string,
) =>
  deps.runAsUser(userId)(async (db) => {
    const now = deps.now().toISOString();
    await db.query(
      "UPDATE public.reminders SET sent_at = $2, send_blocked_reason = NULL WHERE id = $1",
      [id, now],
    );
    await db.query(
      `UPDATE public.invoices
       SET gmail_thread_id = coalesce(gmail_thread_id, $2),
           gmail_thread_subject = coalesce(gmail_thread_subject, $3)
       WHERE id = $1`,
      [ready.ctx.invoice.id, sent.threadId, ready.subject],
    );
    await db.query(
      `INSERT INTO public.messages
         (user_id, invoice_id, direction, body, thread_id, gmail_message_id, rfc_message_id)
       VALUES ((SELECT auth.uid()), $1, 'out', $2, $3, $4, $5)`,
      [ready.ctx.invoice.id, ready.draft.body, sent.threadId, sent.id, rfcMessageId],
    );
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.sent', $2)`,
      [id, JSON.stringify({ tier: ready.ctx.tier, onThread: ready.threadId !== null })],
    );
  });

const ownMessageId = (ownEmail: string): string =>
  `<${randomUUID()}@${ownEmail.split("@")[1] ?? "mail.invalid"}>`;

/** Gmail's own Message-ID if it answers; ours otherwise. The mail has gone either way. */
const askMessageId = async (gmail: GmailClient, id: string, ours: string): Promise<string> => {
  try {
    return (await gmail.rfcMessageId(id)) ?? ours;
  } catch (error) {
    logEvent("sender.message_id_unavailable", { error: errorKind(error) });
    return ours;
  }
};

type Result = "sent" | "held" | "skipped";

const deliver = async (
  deps: SenderDeps,
  userId: string,
  id: string,
  ready: Ready,
): Promise<Result> => {
  const oauth = deps.oauth();
  if (!oauth) {
    await release(deps, userId, id, "gmail_disconnected");
    return "held";
  }
  let pdf: PdfFile | undefined;
  try {
    pdf = await deps.pdf(userId, ready.ctx.invoice.id);
  } catch (error) {
    logEvent("sender.pdf_failed", { reminderId: id, error: errorKind(error) });
  }
  if (!pdf) {
    await release(deps, userId, id, "pdf_failed");
    return "held";
  }

  const messageId = ownMessageId(ready.ownEmail);
  const raw = toGmailRaw(
    buildReminderEmail({
      from: { name: ready.ctx.freelancerName, email: ready.ownEmail },
      to: { name: ready.ctx.client.name, email: ready.clientEmail },
      subject: ready.subject,
      body: ready.draft.body,
      pdf,
      messageId,
      references: ready.references,
    }),
  );
  const gmail = gmailClient(oauth, ready.refreshToken);
  try {
    const sent = await gmail.send(raw, ready.threadId);
    const rfcMessageId = await askMessageId(gmail, sent.id, messageId);
    await recordSent(deps, userId, id, ready, sent, rfcMessageId);
    logEvent("sender.sent", { reminderId: id, onThread: ready.threadId !== null });
    return "sent";
  } catch (error) {
    return failed(deps, userId, id, error);
  }
};

const failed = async (
  deps: SenderDeps,
  userId: string,
  id: string,
  error: unknown,
): Promise<Result> => {
  if (error instanceof GmailAuthExpired) {
    await deps.runAsUser(userId)((db) => markGmailNeedsReconnect(db));
    await release(deps, userId, id, "gmail_disconnected");
    logEvent("sender.gmail_needs_reconnect", { reminderId: id });
    return "held";
  }
  if (error instanceof GmailError && !error.outcomeUnknown) {
    await release(deps, userId, id, "send_failed");
    logEvent("sender.send_failed", { reminderId: id, status: error.status });
    return "held";
  }
  // No answer, a server error, or a failure while recording: it may have gone. Never repeat it.
  await flagUnknown(deps, userId, id);
  logEvent("sender.outcome_unknown", { reminderId: id, error: errorKind(error) });
  return "held";
};

const sendOne = async (deps: SenderDeps, userId: string, id: string): Promise<Result> => {
  const step = await deps.runAsUser(userId)((db) => prepare(deps, db, id, deps.now()));
  if (step.kind === "ready") return deliver(deps, userId, id, step.ready);
  return step.kind === "held" ? "held" : "skipped";
};

/** Claims older than this never finished recording, so nobody can tell whether they went. */
const flagAbandoned = (deps: SenderDeps, now: Date) =>
  deps.runAsService((db) =>
    db.query(
      `UPDATE public.reminders SET send_blocked_reason = 'unknown_outcome'
       WHERE approval_status = 'approved' AND sent_at IS NULL AND send_attempted_at < $1
         AND send_blocked_reason IS DISTINCT FROM 'unknown_outcome'`,
      [new Date(now.getTime() - CLAIM_LIFETIME_MS).toISOString()],
    ),
  );

export const runSender = async (deps: SenderDeps): Promise<{ sent: number; held: number }> => {
  const now = deps.now();
  await flagAbandoned(deps, now);
  const due = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT id::text, user_id::text FROM public.reminders
       WHERE approval_status = 'approved' AND sent_at IS NULL AND draft IS NOT NULL
         AND send_attempted_at IS NULL AND scheduled_at <= $1
       ORDER BY scheduled_at LIMIT ${String(RUN_LIMIT)}`,
      [now.toISOString()],
    );
    return rows;
  });
  const totals = { sent: 0, held: 0 };
  // One at a time: a slow PDF or Gmail call shouldn't race the same account's other sends.
  for (const { id, user_id: userId } of due) {
    const result = await sendOne(deps, userId, id);
    if (result === "sent") totals.sent += 1;
    if (result === "held") totals.held += 1;
  }
  return totals;
};
