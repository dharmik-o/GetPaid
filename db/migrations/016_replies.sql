-- Client replies. Any reply holds the invoice's reminders until the freelancer decides: the hold
-- doesn't depend on what the reply says, and it can only delay a reminder. What the AI read is
-- kept as a suggestion, and only the freelancer's decision changes the schedule (security rule 4).
ALTER TABLE public.invoices
  ADD COLUMN reminders_held_at timestamptz,
  ADD COLUMN reminders_paused_until date;
COMMENT ON COLUMN public.invoices.reminders_held_at IS 'A client replied, so nothing goes out until the freelancer decides.';
COMMENT ON COLUMN public.invoices.reminders_paused_until IS 'Set only by the freelancer. Reminders resume on this date, in the client''s time zone.';

ALTER TABLE public.messages
  ADD COLUMN review_status text CHECK (review_status IN ('pending', 'done')),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_action text,
  ADD COLUMN telegram_notified_at timestamptz,
  ADD COLUMN split_plan_id uuid,
  ADD FOREIGN KEY (split_plan_id, user_id) REFERENCES public.installment_plans (id, user_id);
COMMENT ON COLUMN public.messages.review_status IS 'For replies: pending until the freelancer has decided what to do.';
COMMENT ON COLUMN public.messages.split_plan_id IS 'The installment plan made from this reply, so a retry resumes it instead of making another.';
CREATE INDEX messages_pending_review_idx ON public.messages (user_id) WHERE review_status = 'pending';
CREATE INDEX messages_split_plan_id_idx ON public.messages (split_plan_id);
