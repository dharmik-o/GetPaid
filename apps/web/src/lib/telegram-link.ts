import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db";

// Server-only: Connect Telegram. The dashboard makes a one-time code for t.me/<bot>?start=<code>;
// when the bot receives it, the chat is saved on the code's owner. The code is 256 random bits
// and only its hash is stored. Never log the code or the chat ID.

const LINK_LIFETIME_MS = 15 * 60 * 1000;

const hashOf = (code: string): string => createHash("sha256").update(code).digest("hex");

/** Replaces any earlier code: a user has at most one live link. */
export const startTelegramLink = async (db: Db, now: Date): Promise<string> => {
  const code = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + LINK_LIFETIME_MS);
  await db.query(
    `UPDATE public.users SET telegram_link_hash = $1, telegram_link_expires_at = $2
     WHERE id = (SELECT auth.uid())`,
    [hashOf(code), expires.toISOString()],
  );
  return code;
};

export const getTelegramStatus = async (db: Db): Promise<{ connected: boolean }> => {
  const { rows } = await db.query<{ connected: boolean }>(
    "SELECT telegram_chat_id IS NOT NULL AS connected FROM public.users WHERE id = (SELECT auth.uid())",
  );
  return { connected: rows[0]?.connected ?? false };
};

export const disconnectTelegram = async (db: Db): Promise<void> => {
  await db.query(
    `UPDATE public.users
     SET telegram_chat_id = NULL, telegram_link_hash = NULL, telegram_link_expires_at = NULL
     WHERE id = (SELECT auth.uid())`,
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type)
     VALUES ((SELECT auth.uid()), 'user', (SELECT auth.uid()), 'telegram.disconnected')`,
  );
};

export type LinkOutcome = "connected" | "invalid" | "taken";

/**
 * Runs as the service role: the code is the only proof of who this chat belongs to, so there's
 * no signed-in user yet. Callers must have verified the request came from n8n. A chat that
 * belongs to someone else is refused without using up the code.
 */
export const completeTelegramLink = async (
  db: Db,
  code: string,
  chatId: number,
  now: Date,
): Promise<LinkOutcome> => {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM public.users WHERE telegram_link_hash = $1 AND telegram_link_expires_at > $2",
    [hashOf(code), now.toISOString()],
  );
  const owner = rows[0]?.id;
  if (!owner) return "invalid";
  const taken = await db.query(
    "SELECT 1 FROM public.users WHERE telegram_chat_id = $1 AND id <> $2",
    [chatId, owner],
  );
  if (taken.rows.length > 0) return "taken";
  await db.query(
    `UPDATE public.users
     SET telegram_chat_id = $2, telegram_link_hash = NULL, telegram_link_expires_at = NULL
     WHERE id = $1`,
    [owner, chatId],
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type)
     VALUES ($1, 'user', $1, 'telegram.connected')`,
    [owner],
  );
  return "connected";
};
