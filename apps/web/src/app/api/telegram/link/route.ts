import { telegramBotUsername } from "@/lib/env";
import { runAsCurrentUser } from "@/lib/request-user";
import { telegramLinkHandlers } from "@/lib/telegram-handlers";

const handlers = telegramLinkHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  botUsername: () => telegramBotUsername(),
});

export const POST = handlers.post;
export const DELETE = handlers.remove;
