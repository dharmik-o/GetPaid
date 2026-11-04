import { z } from "zod";
import type { UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, noContent, readJson, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { logEvent } from "./log";
import type { ServiceDbRunner } from "./service-db";
import {
  completeTelegramLink,
  disconnectTelegram,
  startTelegramLink,
  type LinkOutcome,
} from "./telegram-link";

// Server-only: POST and DELETE /api/telegram/link (the dashboard, as the signed-in user), and
// POST /api/internal/telegram/update (n8n relays every update from the one bot webhook here, then
// sends the reply this answers with). Telegram text is untrusted: only a code can link a chat.

const emptySchema = z.strictObject({});

/** Telegram adds fields over time, so unknown ones are ignored rather than refused. */
const updateSchema = z.object({
  message: z
    .object({
      chat: z.object({ id: z.int(), type: z.string() }),
      text: z.string().optional(),
    })
    .optional(),
});

/** Telegram's deep-link parameter: up to 64 of A-Z a-z 0-9 _ - */
const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/;

const LINK_REPLIES: Readonly<Record<LinkOutcome, string>> = {
  connected: "Connected. Reminder drafts will arrive here for you to approve.",
  invalid:
    "That link has expired or was already used. Open Settings > Integrations in the dashboard and tap Connect Telegram again.",
  taken:
    "This Telegram chat is linked to another account. Disconnect it there first, then tap Connect Telegram again.",
};

const NO_CODE_REPLY =
  "To connect, open Settings > Integrations in the dashboard and tap Connect Telegram.";

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

type UpdateDeps = {
  runAsService: ServiceDbRunner;
  now: () => Date;
  token: () => string | undefined;
};

export const telegramUpdateHandler = ({ runAsService, now, token }: UpdateDeps) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, token(), "telegram.update_rejected");
    if (refused) return refused;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = updateSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const { message } = parsed.data;
    const start = message?.chat.type === "private" ? START.exec(message.text?.trim() ?? "") : null;
    if (!message || !start) return jsonResponse({ reply: null });
    const chatId = message.chat.id;
    const code = start[1];
    if (!code) return jsonResponse({ reply: { chatId, text: NO_CODE_REPLY } });
    try {
      const outcome = await runAsService((db) => completeTelegramLink(db, code, chatId, now()));
      logEvent("telegram.link", { outcome });
      return jsonResponse({ reply: { chatId, text: LINK_REPLIES[outcome] } });
    } catch (error) {
      return serverError("telegram.update_failed", error);
    }
  },
});
