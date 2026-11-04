-- Gmail: the connected account, and each invoice's thread. Only Gmail thread IDs stored here are
-- ever read (security rule 7). The refresh token stays in users.gmail_token_enc, as ciphertext.
ALTER TABLE public.users
  ADD COLUMN gmail_email text,
  ADD COLUMN gmail_status text NOT NULL DEFAULT 'disconnected'
    CHECK (gmail_status IN ('disconnected', 'connected', 'needs_reconnect')),
  ADD COLUMN gmail_reconnect_notified_at timestamptz,
  ADD COLUMN gmail_oauth_state_hash text,
  ADD COLUMN gmail_oauth_state_expires_at timestamptz,
  ADD CONSTRAINT users_gmail_state_complete
    CHECK ((gmail_oauth_state_hash IS NULL) = (gmail_oauth_state_expires_at IS NULL));
COMMENT ON COLUMN public.users.gmail_status IS 'needs_reconnect: Google refused the token (invalid_grant). Sends stay held, never dropped, until reconnected.';
COMMENT ON COLUMN public.users.gmail_oauth_state_hash IS 'SHA-256 of the one-time OAuth state. Cleared when the callback arrives.';

ALTER TABLE public.invoices
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN gmail_thread_subject text;
COMMENT ON COLUMN public.invoices.gmail_thread_id IS 'Stored when the first reminder is sent. The only threads the app may read.';
COMMENT ON COLUMN public.invoices.gmail_thread_subject IS 'Every follow-up keeps this subject, so Gmail keeps it on the thread.';
CREATE INDEX invoices_gmail_thread_id_idx ON public.invoices (gmail_thread_id);

ALTER TABLE public.messages
  ADD COLUMN gmail_message_id text,
  ADD COLUMN rfc_message_id text;
CREATE UNIQUE INDEX messages_one_per_gmail_message
  ON public.messages (user_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL;

-- send_attempted_at is set before Gmail is called and cleared only when the send certainly failed,
-- so a send whose outcome is unknown is never repeated by itself.
ALTER TABLE public.reminders
  ADD COLUMN send_attempted_at timestamptz,
  ADD COLUMN send_blocked_reason text
    CHECK (send_blocked_reason IN ('gmail_disconnected', 'not_allowlisted', 'draft_invalid',
      'no_pay_link', 'paused', 'on_hold', 'send_failed', 'pdf_failed', 'unknown_outcome')),
  ADD COLUMN telegram_sent_notified_at timestamptz;
COMMENT ON COLUMN public.reminders.send_blocked_reason IS 'Why an approved draft is being held. It is kept, never dropped.';
