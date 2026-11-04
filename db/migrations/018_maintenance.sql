-- 018_maintenance: maintenance and renewal reminders, and the heads-up to the client (M8).
--
-- A heads-up goes through the normal approval flow, so it's a row in reminders. It has no invoice:
-- a reminder now belongs to exactly one invoice or one maintenance task. The same goes for the
-- message recording it. The Reply listener still reads only invoice threads.
--
-- Telegram cards for a task: notice_pending means one is due, telegram_message_id is the card whose
-- buttons work, and telegram_stale_message_id is a card still to be closed.
--
-- job_project_id: "Create invoice" makes a small project and milestone for this occurrence of the
-- job, so it uses the existing invoice flow. job_due_on says which occurrence.

ALTER TABLE public.maintenance_tasks
  ADD CONSTRAINT maintenance_tasks_id_user_id_key UNIQUE (id, user_id),
  ADD COLUMN snoozed_until date,
  ADD COLUMN last_notice_on date,
  ADD COLUMN last_done_on date,
  ADD COLUMN notice_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN telegram_message_id bigint,
  ADD COLUMN telegram_card_sent_at timestamptz,
  ADD COLUMN telegram_stale_message_id bigint,
  ADD COLUMN job_project_id uuid,
  ADD COLUMN job_due_on date,
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN gmail_thread_subject text,
  ADD CONSTRAINT maintenance_tasks_job_project_fkey
    FOREIGN KEY (job_project_id, user_id) REFERENCES public.projects (id, user_id)
    ON DELETE SET NULL (job_project_id);

CREATE INDEX maintenance_tasks_job_project_id_idx ON public.maintenance_tasks (job_project_id);

COMMENT ON COLUMN public.maintenance_tasks.last_notice_on IS 'The date the freelancer was last told, in their own time zone.';
COMMENT ON COLUMN public.maintenance_tasks.job_due_on IS 'The next_due that job_project_id was made for.';

ALTER TABLE public.reminders
  ALTER COLUMN invoice_id DROP NOT NULL,
  ADD COLUMN maintenance_task_id uuid,
  ADD COLUMN maintenance_due_on date,
  DROP CONSTRAINT reminders_tier_check,
  ADD CONSTRAINT reminders_tier_check
    CHECK (tier IN ('courtesy', 'tier1', 'tier2', 'tier3', 'maintenance')),
  ADD CONSTRAINT reminders_one_source CHECK (num_nonnulls(invoice_id, maintenance_task_id) = 1),
  ADD CONSTRAINT reminders_maintenance_tier
    CHECK ((tier = 'maintenance') = (maintenance_task_id IS NOT NULL)),
  ADD CONSTRAINT reminders_maintenance_task_fkey
    FOREIGN KEY (maintenance_task_id, user_id) REFERENCES public.maintenance_tasks (id, user_id)
    ON DELETE CASCADE;

CREATE INDEX reminders_maintenance_task_id_idx ON public.reminders (maintenance_task_id);

-- One heads-up in progress per task, like one reminder in progress per invoice.
CREATE UNIQUE INDEX reminders_one_open_per_task
  ON public.reminders (maintenance_task_id)
  WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved');

COMMENT ON COLUMN public.reminders.maintenance_due_on IS 'The due date this heads-up was written about; a moved job stops it.';

ALTER TABLE public.messages
  ALTER COLUMN invoice_id DROP NOT NULL,
  ADD COLUMN maintenance_task_id uuid,
  ADD CONSTRAINT messages_one_source CHECK (num_nonnulls(invoice_id, maintenance_task_id) = 1),
  ADD CONSTRAINT messages_maintenance_task_fkey
    FOREIGN KEY (maintenance_task_id, user_id) REFERENCES public.maintenance_tasks (id, user_id)
    ON DELETE CASCADE;

CREATE INDEX messages_maintenance_task_id_idx ON public.messages (maintenance_task_id);
