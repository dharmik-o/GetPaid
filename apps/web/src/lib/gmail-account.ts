import { createHash, randomBytes } from "node:crypto";
import type { SecretBox } from "./crypto";
import type { Db } from "./db";

// Server-only: the connected Gmail account, read and changed as its owner (RLS). The refresh
// token is ciphertext at rest, bound to the user, and never leaves the server.

const STATE_LIFETIME_MS = 10 * 60 * 1000;

export type GmailStatus = "disconnected" | "connected" | "needs_reconnect";

export type GmailAccount = { status: GmailStatus; email: string | null };

export const gmailTokenContext = (userId: string): string => `users.gmail_token_enc:${userId}`;

const hashOf = (value: string): string => createHash("sha256").update(value).digest("hex");

export const getGmailAccount = async (db: Db): Promise<GmailAccount> => {
  const { rows } = await db.query<{ gmail_status: GmailStatus; gmail_email: string | null }>(
    "SELECT gmail_status, gmail_email FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const row = rows[0];
  return { status: row?.gmail_status ?? "disconnected", email: row?.gmail_email ?? null };
};

/** The one-time state for Google's consent page; a new one replaces any earlier one. */
export const startGmailConnect = async (db: Db, now: Date): Promise<string> => {
  const state = randomBytes(32).toString("base64url");
  await db.query(
    `UPDATE public.users SET gmail_oauth_state_hash = $1, gmail_oauth_state_expires_at = $2
     WHERE id = (SELECT auth.uid())`,
    [hashOf(state), new Date(now.getTime() + STATE_LIFETIME_MS).toISOString()],
  );
  return state;
};

/**
 * True if this was the signed-in user's live state, which is then used up. A wrong one changes
 * nothing, so a stray request can't cancel a connection in progress.
 */
export const consumeGmailState = async (db: Db, state: string, now: Date): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE public.users SET gmail_oauth_state_hash = NULL, gmail_oauth_state_expires_at = NULL
     WHERE id = (SELECT auth.uid()) AND gmail_oauth_state_hash = $1
       AND gmail_oauth_state_expires_at > $2`,
    [hashOf(state), now.toISOString()],
  );
  return rowCount > 0;
};

export const saveGmailConnection = async (
  db: Db,
  {
    userId,
    refreshToken,
    email,
    box,
  }: {
    userId: string;
    refreshToken: string;
    email: string;
    box: SecretBox;
  },
): Promise<void> => {
  await db.query(
    `UPDATE public.users
     SET gmail_token_enc = $2, gmail_email = $3, gmail_status = 'connected',
         gmail_reconnect_notified_at = NULL
     WHERE id = $1`,
    [userId, box.encrypt(refreshToken, gmailTokenContext(userId)), email],
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type)
     VALUES ($1, 'user', $1, 'gmail.connected')`,
    [userId],
  );
};

export const disconnectGmail = async (db: Db): Promise<void> => {
  await db.query(
    `UPDATE public.users
     SET gmail_token_enc = NULL, gmail_email = NULL, gmail_status = 'disconnected',
         gmail_reconnect_notified_at = NULL
     WHERE id = (SELECT auth.uid())`,
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type)
     VALUES ((SELECT auth.uid()), 'user', (SELECT auth.uid()), 'gmail.disconnected')`,
  );
};

/** Google refused the token: it's dead, so it's dropped, and everything waits for a reconnect. */
export const markGmailNeedsReconnect = async (db: Db): Promise<void> => {
  const { rowCount } = await db.query(
    `UPDATE public.users SET gmail_token_enc = NULL, gmail_status = 'needs_reconnect'
     WHERE id = (SELECT auth.uid()) AND gmail_status = 'connected'`,
  );
  if (rowCount === 0) return;
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type)
     VALUES ((SELECT auth.uid()), 'user', (SELECT auth.uid()), 'gmail.needs_reconnect')`,
  );
};

/** The refresh token, for this request only. Never log or return it. */
export const loadGmailRefreshToken = async (
  db: Db,
  box: SecretBox,
): Promise<string | undefined> => {
  const { rows } = await db.query<{ id: string; gmail_token_enc: string | null }>(
    "SELECT id::text, gmail_token_enc FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const row = rows[0];
  return row?.gmail_token_enc
    ? box.decrypt(row.gmail_token_enc, gmailTokenContext(row.id))
    : undefined;
};
