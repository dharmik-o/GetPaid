import type { Classification } from "./ai-schemas";
import { loadAiConnections } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { toCents } from "./db-values";
import type { GmailOAuthEnv } from "./env";
import { formatFullDay, formatMoney } from "./format";
import { GmailAuthExpired, GmailError, gmailClient, type GmailThreadMessage } from "./gmail";
import { loadGmailRefreshToken, markGmailNeedsReconnect } from "./gmail-account";
import { fromAddress, messageHeader, messageText } from "./gmail-message";
import { errorKind, logEvent } from "./log";
import { classifyReply } from "./reply-classifier";
import { todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";

// Server-only: n8n's 05_reply_listener calls this. It reads only the thread IDs the sender stored
// (security rule 7), and only while their invoice is unpaid. Reply text is untrusted (rule 4): the
// AI's reading is saved as a suggestion. Any reply puts the invoice on hold, whatever it says, and
// a hold can only delay a reminder. Everything else waits for the freelancer's decision.

export type ReplyListenerDeps = {
  runAsService: ServiceDbRunner;
  runAsUser: (userId: string) => UserDbRunner;
  now: () => Date;
  box: () => SecretBox;
  oauth: () => GmailOAuthEnv | undefined;
};

const THREAD_LIMIT = 200;

type ThreadRow = { user_id: string; own_email: string; thread_id: string };

/** The only place thread IDs for reading come from: what the sender stored. */
const storedThreads = (deps: ReplyListenerDeps): Promise<ThreadRow[]> =>
  deps.runAsService(async (db) => {
    const { rows } = await db.query<ThreadRow>(
      `SELECT DISTINCT i.user_id::text, u.gmail_email AS own_email, i.gmail_thread_id AS thread_id
       FROM public.invoices i JOIN public.users u ON u.id = i.user_id
       WHERE i.gmail_thread_id IS NOT NULL AND i.status IN ('sent', 'partially_paid')
         AND u.gmail_status = 'connected' AND u.gmail_email IS NOT NULL
       LIMIT ${String(THREAD_LIMIT)}`,
    );
    return rows;
  });

const groupByUser = (rows: ThreadRow[]): Map<string, ThreadRow[]> => {
  const users = new Map<string, ThreadRow[]>();
  for (const row of rows) users.set(row.user_id, [...(users.get(row.user_id) ?? []), row]);
  return users;
};

const unseen = async (db: Db, messages: GmailThreadMessage[]): Promise<Set<string>> => {
  const { rows } = await db.query<{ gmail_message_id: string }>(
    "SELECT gmail_message_id FROM public.messages WHERE gmail_message_id = ANY($1::text[])",
    [messages.map((message) => message.id)],
  );
  const known = new Set(rows.map((row) => row.gmail_message_id));
  return new Set(messages.map((message) => message.id).filter((id) => !known.has(id)));
};

const isFromClient = (message: GmailThreadMessage, ownEmail: string): boolean =>
  !message.labelIds.includes("SENT") &&
  !message.labelIds.includes("DRAFT") &&
  fromAddress(message) !== ownEmail.toLowerCase();

type ThreadInvoice = {
  id: string;
  due_date: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  time_zone: string;
};

/** The thread's earliest unpaid invoice is the one a reply is filed against. */
const invoiceForThread = async (db: Db, threadId: string): Promise<ThreadInvoice | undefined> => {
  const { rows } = await db.query<ThreadInvoice>(
    `SELECT i.id::text, i.due_date::text, i.amount_cents::text, i.amount_paid_cents::text,
       i.currency, c.time_zone
     FROM public.invoices i
     JOIN public.milestones m ON m.id = i.milestone_id
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE i.gmail_thread_id = $1 AND i.status IN ('sent', 'partially_paid')
     ORDER BY coalesce(i.installment_number, 0), i.due_date LIMIT 1`,
    [threadId],
  );
  return rows[0];
};

/** Saved once, however often it runs. The hold covers every unpaid invoice on the thread. */
const saveReply = async (
  db: Db,
  {
    invoiceId,
    threadId,
    message,
    text,
    classification,
    now,
  }: {
    invoiceId: string;
    threadId: string;
    message: GmailThreadMessage;
    text: string;
    classification: Classification;
    now: Date;
  },
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO public.messages (user_id, invoice_id, direction, body, ai_classification, thread_id,
       gmail_message_id, rfc_message_id, review_status)
     VALUES ((SELECT auth.uid()), $1, 'in', $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (user_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL DO NOTHING`,
    [
      invoiceId,
      text,
      JSON.stringify(classification),
      threadId,
      message.id,
      messageHeader(message, "Message-ID") ?? null,
    ],
  );
  if (rowCount === 0) return false;
  await db.query(
    `UPDATE public.invoices SET reminders_held_at = $2
     WHERE gmail_thread_id = $1 AND status IN ('sent', 'partially_paid')`,
    [threadId, now.toISOString()],
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'invoice', $1, 'reply.received', $2)`,
    [invoiceId, JSON.stringify({ label: classification.label })],
  );
  return true;
};

const handleReply = async (
  deps: ReplyListenerDeps,
  userId: string,
  threadId: string,
  message: GmailThreadMessage,
): Promise<boolean> => {
  const now = deps.now();
  const prepared = await deps.runAsUser(userId)(async (db) => {
    const invoice = await invoiceForThread(db, threadId);
    if (!invoice) return undefined;
    return { invoice, connections: await loadAiConnections(db, "sort", deps.box()) };
  });
  if (!prepared) return false;
  const { invoice, connections } = prepared;
  const text = messageText(message);
  // The model call runs outside any transaction: it can take a minute on a local model.
  const classification = await classifyReply(connections, text, {
    today: todayIn(now, invoice.time_zone),
    dueDate: formatFullDay(invoice.due_date),
    amountDue: formatMoney(
      toCents(invoice.amount_cents) - toCents(invoice.amount_paid_cents),
      invoice.currency,
    ),
  });
  return deps.runAsUser(userId)((db) =>
    saveReply(db, { invoiceId: invoice.id, threadId, message, text, classification, now }),
  );
};

const readUser = async (
  deps: ReplyListenerDeps,
  userId: string,
  threads: ThreadRow[],
  oauth: GmailOAuthEnv,
): Promise<{ read: number; replies: number }> => {
  const refreshToken = await deps.runAsUser(userId)((db) => loadGmailRefreshToken(db, deps.box()));
  if (!refreshToken) return { read: 0, replies: 0 };
  const gmail = gmailClient(oauth, refreshToken);
  const totals = { read: 0, replies: 0 };
  for (const { thread_id: threadId, own_email: ownEmail } of threads) {
    try {
      const thread = await gmail.thread(threadId);
      totals.read += 1;
      const fromClient = thread.messages.filter((message) => isFromClient(message, ownEmail));
      const fresh = await deps.runAsUser(userId)((db) => unseen(db, fromClient));
      for (const message of fromClient.filter((m) => fresh.has(m.id))) {
        if (await handleReply(deps, userId, threadId, message)) totals.replies += 1;
      }
    } catch (error) {
      if (error instanceof GmailAuthExpired) throw error;
      // One thread that can't be read shouldn't stop the others; it's tried again next run.
      logEvent("replies.thread_failed", {
        status: error instanceof GmailError ? error.status : null,
        error: errorKind(error),
      });
    }
  }
  return totals;
};

export const runReplyListener = async (
  deps: ReplyListenerDeps,
): Promise<{ read: number; replies: number }> => {
  const oauth = deps.oauth();
  if (!oauth) return { read: 0, replies: 0 };
  const totals = { read: 0, replies: 0 };
  for (const [userId, threads] of groupByUser(await storedThreads(deps))) {
    try {
      const done = await readUser(deps, userId, threads, oauth);
      totals.read += done.read;
      totals.replies += done.replies;
    } catch (error) {
      if (!(error instanceof GmailAuthExpired)) throw error;
      await deps.runAsUser(userId)((db) => markGmailNeedsReconnect(db));
      logEvent("replies.gmail_needs_reconnect", { userId });
    }
  }
  if (totals.replies > 0) logEvent("replies.run", totals);
  return totals;
};
