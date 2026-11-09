-- 031_agreement_signing: Phase 2 part C, step C3. What sending and signing an agreement need:
--   * the agreement's own Gmail thread, so the signed copy follows the request
--   * the agreement as the source of a sent message (the evidence timeline and the lawyer pack)
--   * a mark that the freelancer was told on Telegram that it was signed or declined

ALTER TABLE public.agreements
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN gmail_thread_subject text,
  ADD COLUMN telegram_notified_at timestamptz;

ALTER TABLE public.messages
  ADD COLUMN agreement_id uuid,
  DROP CONSTRAINT messages_one_source,
  ADD CONSTRAINT messages_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id, hold_id, agreement_id) = 1),
  ADD CONSTRAINT messages_agreement_fkey
    FOREIGN KEY (agreement_id, user_id) REFERENCES public.agreements (id, user_id) ON DELETE CASCADE;
CREATE INDEX messages_agreement_id_idx ON public.messages (agreement_id);

-- At most one unsent email of each kind per agreement.
CREATE UNIQUE INDEX reminders_one_open_per_agreement_email
  ON public.reminders (agreement_id, tier)
  WHERE agreement_id IS NOT NULL AND sent_at IS NULL AND approval_status IN ('waiting', 'approved');
