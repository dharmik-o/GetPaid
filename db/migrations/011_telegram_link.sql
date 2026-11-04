-- Connect Telegram: the one-time code behind t.me/<bot>?start=<code>. A user has at most one live
-- code, and only its SHA-256 is stored, so a leaked database row can't link a chat.
ALTER TABLE public.users
  ADD COLUMN telegram_link_hash text UNIQUE,
  ADD COLUMN telegram_link_expires_at timestamptz,
  ADD CONSTRAINT users_telegram_link_complete
    CHECK ((telegram_link_hash IS NULL) = (telegram_link_expires_at IS NULL));
COMMENT ON COLUMN public.users.telegram_link_hash IS 'SHA-256 of the one-time Connect Telegram code. Cleared when used.';
