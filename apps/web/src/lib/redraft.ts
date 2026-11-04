import { routeTask } from "./ai-router";
import { loadAiConnections, type AiConnection } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { checkedDraftSchema } from "./draft-checks";
import type { DraftRequest } from "./draft-facts";
import { redraftMessages } from "./draft-prompts";
import { notPayable, reminderFacts } from "./drafter";
import type { Law } from "./legal";
import { logEvent } from "./log";
import { loadMaintenanceContext } from "./maintenance-context";
import { loadReminderContext } from "./reminder-context";
import { storedDraftSchema, type StoredDraft } from "./stored-draft";

// Server-only: a plain-word edit from Telegram. The note is untrusted text, quoted to the model.
// The answer passes the same checks as any draft, and there's no template fallback: if no model
// gives a good answer, the current draft stays as it is. The result still waits for approval.

export type RedraftDeps = {
  runAsUser: (userId: string) => UserDbRunner;
  box: () => SecretBox;
  now: () => Date;
  laws: readonly Law[];
};

export type RedraftOutcome =
  | { status: "redrafted"; oldMessageId: number | null }
  | { status: "handled" }
  | { status: "failed" };

type Ready = {
  request: DraftRequest;
  current: StoredDraft;
  connections: AiConnection[];
  oldMessageId: number | null;
};

const prepare = (deps: RedraftDeps, userId: string, id: string): Promise<Ready | undefined> =>
  deps.runAsUser(userId)(async (db) => {
    const ctx = await loadReminderContext(db, id);
    const job = ctx ? undefined : await loadMaintenanceContext(db, id);
    if (job?.approvalStatus !== "waiting" && ctx?.approvalStatus !== "waiting") return undefined;
    if (ctx && (notPayable(ctx) || !ctx.invoice.link)) return undefined;
    const { rows } = await db.query<{ draft: unknown; telegram_message_id: string | null }>(
      "SELECT draft, telegram_message_id::text FROM public.reminders WHERE id = $1",
      [id],
    );
    const current = storedDraftSchema.safeParse(rows[0]?.draft);
    if (!current.success) return undefined;
    const request: DraftRequest | undefined = ctx
      ? { kind: ctx.tier, facts: reminderFacts(ctx, deps.now(), ctx.invoice.link ?? "", deps.laws) }
      : job && { kind: "maintenance", facts: job.facts };
    if (!request) return undefined;
    const task = request.kind === "tier3" ? "tier3" : "draft";
    return {
      request,
      current: current.data,
      connections: await loadAiConnections(db, task, deps.box()),
      oldMessageId: rows[0]?.telegram_message_id ? Number(rows[0].telegram_message_id) : null,
    };
  });

/** The new wording. A freelancer's earlier edit is replaced, so `editedAt` doesn't carry over. */
const nextDraft = (
  current: StoredDraft,
  output: { subject: string; body: string },
  model: { model: string; isLocal: boolean },
  now: Date,
): StoredDraft => ({
  ...current,
  ...output,
  via: "model",
  model: model.model,
  isLocal: model.isLocal,
  draftedAt: now.toISOString(),
  editedAt: undefined,
});

export const redraftReminder = async (
  deps: RedraftDeps,
  { userId, reminderId, feedback }: { userId: string; reminderId: string; feedback: string },
): Promise<RedraftOutcome> => {
  const ready = await prepare(deps, userId, reminderId);
  if (!ready) return { status: "handled" };
  const { request, current, connections, oldMessageId } = ready;
  // The model call runs outside any transaction: it can take a minute on a local model.
  const result = await routeTask(connections, {
    messages: redraftMessages(request, current, feedback),
    schema: checkedDraftSchema(request, deps.laws),
  });
  if (!result.ok || result.via !== "model") {
    logEvent("telegram.redraft_failed", { reminderId });
    return { status: "failed" };
  }
  const draft = nextDraft(current, result.output, result, deps.now());
  return deps.runAsUser(userId)(async (db): Promise<RedraftOutcome> => {
    // A new card follows, so the old one's id and hand-over time are cleared with the wording.
    const { rowCount } = await db.query(
      `UPDATE public.reminders
       SET draft = $2, telegram_message_id = NULL, telegram_card_sent_at = NULL,
         telegram_card_stale = false, telegram_nudged_at = NULL
       WHERE id = $1 AND approval_status = 'waiting'`,
      [reminderId, JSON.stringify(draft)],
    );
    if (rowCount === 0) return { status: "handled" };
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.redrafted', $2)`,
      [reminderId, JSON.stringify({ via: "telegram", model: result.model })],
    );
    return { status: "redrafted", oldMessageId };
  });
};
