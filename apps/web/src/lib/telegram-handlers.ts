import { z } from "zod";
import type { UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, noContent, readJson, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { recordCardDelivered, telegramRun } from "./telegram-cards";
import { disconnectTelegram, startTelegramLink } from "./telegram-link";
import { handleTelegramUpdate, updateSchema, type UpdateDeps } from "./telegram-updates";

// Server-only: POST and DELETE /api/telegram/link (the dashboard, as the signed-in user), and the
// routes under /api/internal/telegram that n8n calls with its token. n8n relays every update from
// the one bot webhook, and sends the steps these answer with.

const emptySchema = z.strictObject({});

const deliveredSchema = z.strictObject({
  reminderId: z.uuid({ error: "must be a reminder id" }),
  messageId: z.int({ error: "must be a message id" }),
});

type LinkDeps = {
  runAsUser: UserDbRunner;
  now: () => Date;
  botUsername: () => string | undefined;
};

export const telegramLinkHandlers = ({ runAsUser, now, botUsername }: LinkDeps) => ({
  post: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = emptySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const bot = botUsername();
    if (!bot) {
      return jsonResponse(
        {
          error: "Telegram isn't set up: set TELEGRAM_BOT_USERNAME (see .env.example) and restart.",
        },
        503,
      );
    }
    try {
      const code = await runAsUser((db) => startTelegramLink(db, now()));
      return jsonResponse({ url: `https://t.me/${bot}?start=${code}` }, 201);
    } catch (error) {
      return serverError("telegram.link_failed", error);
    }
  },

  remove: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = emptySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      await runAsUser((db) => disconnectTelegram(db));
      return noContent();
    } catch (error) {
      return serverError("telegram.disconnect_failed", error);
    }
  },
});

type InternalDeps = UpdateDeps & { token: () => string | undefined };

export const telegramUpdateHandler = (deps: InternalDeps) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "telegram.update_rejected");
    if (refused) return refused;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = updateSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      return jsonResponse({ ops: await handleTelegramUpdate(deps, parsed.data) });
    } catch (error) {
      return serverError("telegram.update_failed", error);
    }
  },
});

export const telegramCardHandlers = (
  deps: Pick<InternalDeps, "runAsService" | "now" | "token" | "outboxUrl">,
) => ({
  pending: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "telegram.pending_rejected");
    if (refused) return refused;
    try {
      const ops = await deps.runAsService((db) => telegramRun(db, deps.now(), deps.outboxUrl()));
      return jsonResponse({ ops });
    } catch (error) {
      return serverError("telegram.pending_failed", error);
    }
  },

  delivered: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "telegram.delivered_rejected");
    if (refused) return refused;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = deliveredSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const { reminderId, messageId } = parsed.data;
      const saved = await deps.runAsService((db) => recordCardDelivered(db, reminderId, messageId));
      return jsonResponse({ saved });
    } catch (error) {
      return serverError("telegram.delivered_failed", error);
    }
  },
});
