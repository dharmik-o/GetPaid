-- Keeping Telegram and the Outbox in step. A card is stale when its draft's wording or send time
-- changed in the dashboard: its buttons stop working until the new card goes out, so nobody can
-- approve wording they weren't shown.
ALTER TABLE public.reminders
  ADD COLUMN telegram_card_closed_at timestamptz,
  ADD COLUMN telegram_card_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN telegram_nudged_at timestamptz;
COMMENT ON COLUMN public.reminders.telegram_card_closed_at IS 'When the card was changed to say the draft was handled. Its buttons stop working as soon as the draft is handled, whether or not this is set.';
COMMENT ON COLUMN public.reminders.telegram_nudged_at IS 'When the one reminder to the freelancer went out. The draft stays held afterwards: it is never sent on its own.';
