import { z } from "zod";
import { isUuid, type UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { replaceWithInstallments } from "./invoice-split";
import { logEvent } from "./log";
import { PaypalError, type PaypalClient } from "./paypal";
import { runReplyListener, type ReplyListenerDeps } from "./replies";
import { applyReply, resumeInvoice, resumeReply, type ReviewResult } from "./reply-review";

// Server-only: POST /api/replies/[id] (the freelancer's decision), POST
// /api/invoices/[id]/resume-reminders, and POST /api/internal/replies/run (n8n's listener).

const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("apply") }),
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("split"), items: z.unknown() }),
]);

const emptySchema = z.strictObject({});

const REPLY = "Reply";

const HANDLED =
  "This reply was already handled, here or on Telegram. Refresh to see where it is now.";

const reviewResponse = (result: ReviewResult): Response => {
  switch (result.status) {
    case "ok":
      return jsonResponse({ done: result.done, until: result.until ?? null });
    case "split_needed":
      return jsonResponse({ error: "Check the amounts and dates, then approve the split." }, 409);
    case "not_found":
      return notFound(REPLY);
    case "handled":
      return jsonResponse({ error: HANDLED }, 409);
  }
};

type ReviewDeps = {
  runAsUser: UserDbRunner;
  now: () => Date;
  paypal: () => PaypalClient;
  pdf?: (invoiceId: string) => Promise<unknown>;
};
type IdContext = { params: Promise<{ id: string }> };

const split = async (deps: ReviewDeps, id: string, items: unknown): Promise<Response> => {
  let paypal: PaypalClient;
  try {
    paypal = deps.paypal();
  } catch {
    return jsonResponse(
      { error: "PayPal isn't set up, so the invoices can't be replaced. See .env.example." },
      503,
    );
  }
  const result = await replaceWithInstallments(
    {
      runAsUser: deps.runAsUser,
      paypal,
      now: deps.now(),
      ...(deps.pdf ? { pdf: deps.pdf } : {}),
    },
    id,
    items,
  );
  if (result.ok) return jsonResponse({ invoices: result.invoices });
  if ("notFound" in result) return notFound(REPLY);
  if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
  return fieldErrors(result.errors);
};

export const replyHandlers = (deps: ReviewDeps) => ({
  post: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(REPLY);
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = actionSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const action = parsed.data;
    try {
      if (action.action === "split") return await split(deps, id, action.items);
      const work = action.action === "apply" ? applyReply : resumeReply;
      const result = await deps.runAsUser((db) => work(db, id, deps.now()));
      logEvent("replies.decided", { replyId: id, action: action.action, status: result.status });
      return reviewResponse(result);
    } catch (error) {
      if (error instanceof PaypalError) {
        logEvent("replies.split_failed", { status: error.status, debugId: error.debugId });
        return jsonResponse({ error: error.message }, 502);
      }
      return serverError("replies.decide_failed", error);
    }
  },

  resumeInvoice: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Invoice");
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = emptySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const found = await deps.runAsUser((db) => resumeInvoice(db, id));
      return found ? jsonResponse({ done: "resume" }) : notFound("Invoice");
    } catch (error) {
      return serverError("replies.resume_failed", error);
    }
  },
});

export const replyListenerHandler = (
  deps: ReplyListenerDeps & { token: () => string | undefined },
) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "replies.rejected");
    if (refused) return refused;
    try {
      return jsonResponse(await runReplyListener(deps));
    } catch (error) {
      return serverError("replies.failed", error);
    }
  },
});
