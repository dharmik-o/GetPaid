-- 017_retainers: what auto-pay and invoice-each-cycle retainers need (M8).
--
-- PayPal ids and request ids: each create call is keyed by a request id saved before the call, and
-- each id PayPal returns is saved as soon as it's known, so a retry resumes instead of repeating.
--
-- invoices.retainer_cycle_on: the charge date this invoice covers, one open invoice per cycle.
-- A row whose retainer_settled_at is set was overtaken: PayPal's own retry collected the money, so
-- the invoice must be cancelled and gets no reminders.
--
-- retainer_alerts: what the freelancer must hear about (Telegram and a dashboard flag). The wording
-- is made when it's shown, from the database, never from a webhook body.

ALTER TABLE public.retainers
  ADD COLUMN paypal_product_id text,
  ADD COLUMN paypal_plan_id text,
  ADD COLUMN paypal_approval_link text,
  ADD COLUMN paypal_product_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN paypal_plan_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN paypal_subscription_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN last_paid_at timestamptz;

COMMENT ON COLUMN public.retainers.paypal_approval_link IS 'Where the client approves the subscription; cleared once it is active.';

ALTER TABLE public.invoices
  ADD COLUMN retainer_cycle_on date,
  ADD COLUMN retainer_cycle_reason text CHECK (retainer_cycle_reason IN ('cycle', 'payment_failed')),
  ADD COLUMN retainer_settled_at timestamptz,
  ADD CONSTRAINT invoices_cycle_only_for_retainers
    CHECK (retainer_cycle_on IS NULL OR retainer_id IS NOT NULL);

COMMENT ON COLUMN public.invoices.retainer_cycle_on IS 'The charge date this invoice covers, in the client''s time zone.';
COMMENT ON COLUMN public.invoices.retainer_cycle_reason IS 'cycle: an invoice-each-cycle retainer. payment_failed: an auto-pay charge that failed.';
COMMENT ON COLUMN public.invoices.retainer_settled_at IS 'PayPal reported nothing outstanding after this failed charge, so this invoice is no longer owed.';

CREATE UNIQUE INDEX invoices_one_open_per_retainer_cycle
  ON public.invoices (retainer_id, retainer_cycle_on)
  WHERE status <> 'cancelled' AND retainer_cycle_on IS NOT NULL;

CREATE TABLE public.retainer_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  retainer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'payment_failed', 'suspended', 'cancelled', 'recovered', 'paid_twice', 'activated_after_cancel'
  )),
  telegram_notified_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (retainer_id, user_id) REFERENCES public.retainers (id, user_id) ON DELETE CASCADE
);

CREATE INDEX retainer_alerts_retainer_id_idx ON public.retainer_alerts (retainer_id);
CREATE INDEX retainer_alerts_user_id_idx ON public.retainer_alerts (user_id);

CREATE TRIGGER retainer_alerts_set_updated_at BEFORE UPDATE ON public.retainer_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.retainer_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY retainer_alerts_owner ON public.retainer_alerts FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.retainer_alerts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.retainer_alerts TO authenticated, service_role;
