import { randomUUID } from "node:crypto";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { notPayable } from "./drafter";
import type { GmailOAuthEnv } from "./env";
import { GmailAuthExpired, GmailError, gmailClient, type GmailClient } from "./gmail";
import { loadGmailRefreshToken, markGmailNeedsReconnect } from "./gmail-account";
import type { PdfFile } from "./invoice-pdfs";
import { errorKind, logEvent } from "./log";
import { loadStandaloneContext, type StandaloneSource } from "./standalone-draft";
import { loadReminderContext } from "./reminder-context";
import { buildReminderEmail, toGmailRaw } from "./reminder-email";
import { isInsideWindow, todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";
import type { ScheduleSettings } from "./settings";
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

/** What a send is about: an invoice, whose PDF goes with it, or an email with no invoice. */
type Source = { kind: "invoice"; invoiceId: string } | StandaloneSource;

/** Where a send's thread is kept, fixed by its kind, never from a request. */
const THREAD_TABLES: Readonly<Record<Source["kind"], string>> = {
  invoice: "invoices",
  maintenance: "maintenance_tasks",
  auto_pay_approval: "retainers",
};

const sourceId = (source: Source): string => {
  switch (source.kind) {
    case "invoice":
      return source.invoiceId;
    case "maintenance":
      return source.taskId;
    case "auto_pay_approval":
      return source.retainerId;
  }
};

type Ready = {
  source: Source;
  tier: string;
  freelancerName: string;
  clientName: string;
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
  has_invoice: boolean;
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
    `SELECT r.invoice_id IS NOT NULL AS has_invoice, r.draft, r.send_blocked_reason, c.email AS client_email,
       u.gmail_email AS own_email, u.gmail_status,
       coalesce(i.gmail_thread_id, mt.gmail_thread_id, ar.gmail_thread_id) AS gmail_thread_id,
       coalesce(i.gmail_thread_subject, mt.gmail_thread_subject, ar.gmail_thread_subject) AS gmail_thread_subject
     FROM public.reminders r
     LEFT JOIN public.invoices i ON i.id = r.invoice_id
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.maintenance_tasks mt ON mt.id = r.maintenance_task_id
     LEFT JOIN public.retainers ar ON ar.id = r.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id, mt.project_id, ar.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id, ar.client_id)
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

const isSnoozed = (settings: ScheduleSettings, timeZone: string, now: Date): boolean =>
  settings.snoozeUntil !== null && todayIn(now, timeZone) < settings.snoozeUntil;

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

/** The part that differs by source: a reason to stop or hold, or who and what it's about. */
type Target =
  | { stop: string }
  | { hold: HoldReason }
  | {
      source: Source;
      tier: string;
      freelancerName: string;
      clientName: string;
      timeZone: string;
      settings: ScheduleSettings;
      draft: StoredDraft;
    };

const invoiceTarget = async (
  db: Db,
  id: string,
  rawDraft: unknown,
  now: Date,
): Promise<Target | undefined> => {
  const ctx = await loadReminderContext(db, id);
  if (!ctx) return undefined;
  const unpayable = notPayable(ctx);
  if (unpayable) return { stop: unpayable };
  const draft = storedDraftSchema.safeParse(rawDraft);
  if (!draft.success) return { hold: "draft_invalid" };
  if (!ctx.invoice.link || !draft.data.body.includes(ctx.invoice.link)) {
    return { hold: "no_pay_link" };
  }
  const { invoice, client, settings } = ctx;
  if (settings.paused || isSnoozed(settings, client.timeZone, now)) return { hold: "paused" };
  const paused =
    invoice.pausedUntil !== null && todayIn(now, client.timeZone) < invoice.pausedUntil;
  if (invoice.held || paused) return { hold: "on_hold" };
  return {
    source: { kind: "invoice", invoiceId: invoice.id },
    tier: ctx.tier,
    freelancerName: ctx.freelancerName,
    clientName: client.name,
    timeZone: client.timeZone,
    settings,
    draft: draft.data,
  };
};

const standaloneTarget = async (
  db: Db,
  id: string,
  rawDraft: unknown,
  now: Date,
): Promise<Target | undefined> => {
  const other = await loadStandaloneContext(db, id);
  if (!other) return undefined;
  if (other.stopReason) return { stop: other.stopReason };
  const draft = storedDraftSchema.safeParse(rawDraft);
  if (!draft.success) return { hold: "draft_invalid" };
  if (other.requiredLink && !draft.data.body.includes(other.requiredLink)) {
    return { hold: "no_pay_link" };
  }
  const { settings, client } = other;
  if (settings.paused || isSnoozed(settings, client.timeZone, now)) return { hold: "paused" };
  return {
    source: other.source,
    tier: other.tier,
    freelancerName: other.freelancerName,
    clientName: client.name,
    timeZone: client.timeZone,
    settings,
    draft: draft.data,
  };
};

/** Every check before Gmail, then the claim, in one transaction as the freelancer (RLS). */
const prepare = async (deps: SenderDeps, db: Db, id: string, now: Date): Promise<Step> => {
  const row = await loadSendRow(db, id);
  if (!row) return { kind: "done" };
  const previous = row.send_blocked_reason;
  const held = (reason: HoldReason) => hold(db, id, reason, previous);

  const target = row.has_invoice
    ? await invoiceTarget(db, id, row.draft, now)
    : await standaloneTarget(db, id, row.draft, now);
  if (!target) return { kind: "done" };
  if ("stop" in target) return stop(db, id, target.stop);
  if ("hold" in target) return held(target.hold);
  const oauth = deps.oauth();
  const refreshToken =
    oauth && row.gmail_status === "connected" && row.own_email
      ? await loadGmailRefreshToken(db, deps.box())
      : undefined;
  if (!refreshToken || !row.own_email) return held("gmail_disconnected");
  if (!deps.allowlist().has(row.client_email.trim().toLowerCase())) return held("not_allowlisted");
  if (!isInsideWindow(now, target.settings.sendWindow, target.timeZone)) {
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
      source: target.source,
      tier: target.tier,
      freelancerName: target.freelancerName,
      clientName: target.clientName,
      draft: target.draft,
      clientEmail: row.client_email,
      ownEmail: row.own_email,
      threadId: row.gmail_thread_id,
      // Gmail keeps a message on a thread only with the same subject.
      subject: row.gmail_thread_subject ?? target.draft.subject,
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
    const { source } = ready;
    await db.query(
      `UPDATE public.${THREAD_TABLES[source.kind]}
       SET gmail_thread_id = coalesce(gmail_thread_id, $2),
           gmail_thread_subject = coalesce(gmail_thread_subject, $3)
       WHERE id = $1`,
      [sourceId(source), sent.threadId, ready.subject],
    );
    await db.query(
      `INSERT INTO public.messages (user_id, invoice_id, maintenance_task_id, retainer_id,
         direction, body, thread_id, gmail_message_id, rfc_message_id)
       VALUES ((SELECT auth.uid()), $1, $2, $3, 'out', $4, $5, $6, $7)`,
      [
        source.kind === "invoice" ? source.invoiceId : null,
        source.kind === "maintenance" ? source.taskId : null,
        source.kind === "auto_pay_approval" ? source.retainerId : null,
        ready.draft.body,
        sent.threadId,
        sent.id,
        rfcMessageId,
      ],
    );
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.sent', $2)`,
      [id, JSON.stringify({ tier: ready.tier, onThread: ready.threadId !== null })],
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
  let pdf: PdfFile | null = null;
  if (ready.source.kind === "invoice") {
    try {
      pdf = (await deps.pdf(userId, ready.source.invoiceId)) ?? null;
    } catch (error) {
      logEvent("sender.pdf_failed", { reminderId: id, error: errorKind(error) });
    }
    if (!pdf) {
      await release(deps, userId, id, "pdf_failed");
      return "held";
    }
  }

  const messageId = ownMessageId(ready.ownEmail);
  const raw = toGmailRaw(
    buildReminderEmail({
      from: { name: ready.freelancerName, email: ready.ownEmail },
      to: { name: ready.clientName, email: ready.clientEmail },
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
