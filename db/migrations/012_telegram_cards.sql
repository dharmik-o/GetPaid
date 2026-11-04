-- Telegram cards. telegram_card_sent_at is when a card was last handed to n8n, so a slow or failed
-- send isn't repeated every minute. telegram_editing_reminder_id is the draft whose plain-word
-- edit the bot is waiting for: the next message from that chat is the instruction.
ALTER TABLE public.reminders ADD COLUMN telegram_card_sent_at timestamptz;
COMMENT ON COLUMN public.reminders.telegram_card_sent_at IS 'When the card was last handed to n8n. telegram_message_id is set once Telegram confirms it.';

ALTER TABLE public.users
  ADD COLUMN telegram_editing_reminder_id uuid REFERENCES public.reminders (id) ON DELETE SET NULL;
CREATE INDEX users_telegram_editing_reminder_id_idx ON public.users (telegram_editing_reminder_id);
