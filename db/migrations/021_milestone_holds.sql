-- 021_milestone_holds: a client authorizes a milestone's payment at its start, and it's captured on
-- acceptance (M9). PayPal's order and authorization ids and each request id are saved as they're
-- known, so a retry resumes. One hold in progress per milestone.
--
-- The client's approval link goes out as an email draft through the normal approval, so a reminder or
-- a message can now belong to a hold too. Once captured, the money is recorded as a paid invoice, with
-- paypal_order_id set, so client balances, refunds and disputes treat it like any other payment.

CREATE TABLE public.milestone_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN (
    'creating', 'pending_approval', 'authorized', 'capturing', 'captured', 'voided', 'expired', 'failed'
  )),
  paypal_order_id text UNIQUE,
  order_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  authorize_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reauthorize_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  approval_link text,
  authorization_id text,
  authorized_at timestamptz,
  reauthorized_at timestamptz,
  capture_id text,
  capture_failed_at timestamptz,
  invoice_id uuid,
  notice_kind text CHECK (notice_kind IN (
    'authorized', 'captured', 'capture_failed', 'capture_denied', 'expired', 'voided_in_paypal'
  )),
  gmail_thread_id text,
  gmail_thread_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (milestone_id, user_id) REFERENCES public.milestones (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id, user_id) REFERENCES public.invoices (id, user_id)
    ON DELETE SET NULL (invoice_id)
);

COMMENT ON COLUMN public.milestone_holds.authorized_at IS 'The original authorization. PayPal''s 29 days always count from here.';
COMMENT ON COLUMN public.milestone_holds.reauthorized_at IS 'The latest reauthorization. The 3-day honor period restarts from here.';
COMMENT ON COLUMN public.milestone_holds.notice_kind IS 'What the freelancer still has to be told on Telegram. The wording is made from the database.';

CREATE INDEX milestone_holds_user_id_idx ON public.milestone_holds (user_id);
CREATE INDEX milestone_holds_milestone_id_idx ON public.milestone_holds (milestone_id);
CREATE INDEX milestone_holds_invoice_id_idx ON public.milestone_holds (invoice_id);
CREATE INDEX milestone_holds_authorization_id_idx ON public.milestone_holds (authorization_id);
CREATE INDEX milestone_holds_capture_id_idx ON public.milestone_holds (capture_id);

CREATE UNIQUE INDEX milestone_holds_one_live_per_milestone
  ON public.milestone_holds (milestone_id)
  WHERE status IN ('creating', 'pending_approval', 'authorized', 'capturing');

CREATE TRIGGER milestone_holds_set_updated_at BEFORE UPDATE ON public.milestone_holds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.milestone_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY milestone_holds_owner ON public.milestone_holds FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.milestone_holds FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.milestone_holds TO authenticated, service_role;

ALTER TABLE public.reminders
  ADD COLUMN hold_id uuid,
  DROP CONSTRAINT reminders_tier_check,
  ADD CONSTRAINT reminders_tier_check CHECK (tier IN (
    'courtesy', 'tier1', 'tier2', 'tier3', 'maintenance', 'auto_pay_approval', 'hold_approval'
  )),
  DROP CONSTRAINT reminders_one_source,
  ADD CONSTRAINT reminders_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id, hold_id) = 1),
  ADD CONSTRAINT reminders_hold_tier CHECK ((tier = 'hold_approval') = (hold_id IS NOT NULL)),
  ADD CONSTRAINT reminders_hold_fkey
    FOREIGN KEY (hold_id, user_id) REFERENCES public.milestone_holds (id, user_id) ON DELETE CASCADE;

CREATE INDEX reminders_hold_id_idx ON public.reminders (hold_id);

CREATE UNIQUE INDEX reminders_one_open_per_hold
  ON public.reminders (hold_id)
  WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved');

ALTER TABLE public.messages
  ADD COLUMN hold_id uuid,
  DROP CONSTRAINT messages_one_source,
  ADD CONSTRAINT messages_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id, hold_id) = 1),
  ADD CONSTRAINT messages_hold_fkey
    FOREIGN KEY (hold_id, user_id) REFERENCES public.milestone_holds (id, user_id) ON DELETE CASCADE;

CREATE INDEX messages_hold_id_idx ON public.messages (hold_id);
