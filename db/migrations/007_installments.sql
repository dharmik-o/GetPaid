-- 007_installments: installments replace PayPal partial payments (approved change, 3 Nov 2026).
--
-- PayPal's partial payments aren't offered in every country, so the app never uses them. An
-- installment plan splits one milestone into 2 to 12 separate PayPal invoices, each with a fixed
-- amount and its own due date. The plan keeps each installment's amount and due date, because a
-- setup plan and a deposit's second installment exist before their invoices do.

CREATE TABLE public.installment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  count smallint NOT NULL CHECK (count BETWEEN 2 AND 12),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  created_from text NOT NULL CHECK (created_from IN ('setup', 'deposit', 'client_request')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT installment_plans_items_match_count CHECK (jsonb_array_length(items) = count),
  UNIQUE (id, user_id),
  FOREIGN KEY (milestone_id, user_id) REFERENCES public.milestones (id, user_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.installment_plans IS 'Splits one milestone into 2 to 12 installments, each its own PayPal invoice. No PayPal partial payments.';
COMMENT ON COLUMN public.installment_plans.items IS 'One entry per installment, in order: {"amountCents": int, "dueDate": "YYYY-MM-DD" | null}. null = due per the payment terms from the day it is invoiced. Amounts add up to total_cents (checked by the app).';
COMMENT ON COLUMN public.installment_plans.total_cents IS 'What the plan splits: the milestone amount, or the unpaid remainder for a client-request split.';

-- A milestone has at most one active plan.
CREATE UNIQUE INDEX installment_plans_one_active_per_milestone
  ON public.installment_plans (milestone_id) WHERE status = 'active';
CREATE INDEX installment_plans_user_id_idx ON public.installment_plans (user_id);
CREATE INDEX installment_plans_milestone_id_idx ON public.installment_plans (milestone_id);

CREATE TRIGGER installment_plans_set_updated_at BEFORE UPDATE ON public.installment_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.installment_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY installment_plans_owner ON public.installment_plans FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.installment_plans FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_plans TO authenticated, service_role;

-- invoices: which installment an invoice is (all null for a plain invoice) -----------------
ALTER TABLE public.invoices
  ADD COLUMN installment_number smallint CHECK (installment_number BETWEEN 1 AND 12),
  ADD COLUMN installment_count smallint CHECK (installment_count BETWEEN 2 AND 12),
  ADD COLUMN installment_plan_id uuid,
  ADD CONSTRAINT invoices_installment_all_or_none
    CHECK (num_nulls(installment_number, installment_count, installment_plan_id) IN (0, 3)),
  ADD CONSTRAINT invoices_installment_within_count
    CHECK (installment_number IS NULL OR installment_number <= installment_count),
  ADD FOREIGN KEY (installment_plan_id, user_id)
    REFERENCES public.installment_plans (id, user_id);
CREATE INDEX invoices_installment_plan_id_idx ON public.invoices (installment_plan_id);

-- One open invoice per milestone and installment (a plain invoice counts as number 0).
DROP INDEX public.invoices_one_open_per_milestone;
CREATE UNIQUE INDEX invoices_one_open_per_installment
  ON public.invoices (milestone_id, (coalesce(installment_number, 0)))
  WHERE status <> 'cancelled';

-- No more PayPal minimum amount due: deposits are installments now.
ALTER TABLE public.invoices DROP CONSTRAINT invoices_minimum_within_amount;
ALTER TABLE public.invoices DROP COLUMN minimum_due_cents;
