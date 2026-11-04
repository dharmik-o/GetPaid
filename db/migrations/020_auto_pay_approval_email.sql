-- 020_auto_pay_approval_email: the client's auto-pay approval link goes out as an email draft, through
-- the normal approval. A reminder now belongs to exactly one invoice, maintenance task or retainer,
-- and so does the message recording it. The Reply listener still reads only invoice threads.

ALTER TABLE public.reminders
  ADD COLUMN retainer_id uuid,
  DROP CONSTRAINT reminders_tier_check,
  ADD CONSTRAINT reminders_tier_check
    CHECK (tier IN ('courtesy', 'tier1', 'tier2', 'tier3', 'maintenance', 'auto_pay_approval')),
  DROP CONSTRAINT reminders_one_source,
  ADD CONSTRAINT reminders_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id) = 1),
  ADD CONSTRAINT reminders_auto_pay_tier
    CHECK ((tier = 'auto_pay_approval') = (retainer_id IS NOT NULL)),
  ADD CONSTRAINT reminders_retainer_fkey
    FOREIGN KEY (retainer_id, user_id) REFERENCES public.retainers (id, user_id) ON DELETE CASCADE;

CREATE INDEX reminders_retainer_id_idx ON public.reminders (retainer_id);

-- One approval email in progress per retainer.
CREATE UNIQUE INDEX reminders_one_open_per_retainer
  ON public.reminders (retainer_id)
  WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved');

ALTER TABLE public.messages
  ADD COLUMN retainer_id uuid,
  DROP CONSTRAINT messages_one_source,
  ADD CONSTRAINT messages_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id) = 1),
  ADD CONSTRAINT messages_retainer_fkey
    FOREIGN KEY (retainer_id, user_id) REFERENCES public.retainers (id, user_id) ON DELETE CASCADE;

CREATE INDEX messages_retainer_id_idx ON public.messages (retainer_id);

ALTER TABLE public.retainers
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN gmail_thread_subject text;
