-- 004_invoice_numbers: what the invoice flow (M3) needs on each invoice.
--
-- invoice_number: PayPal Invoicing v2 ignores the PayPal-Request-Id header, but refuses a second
-- invoice with the same number. A number fixed on our row before the create call is what makes
-- a retry return the existing PayPal invoice instead of a duplicate. One sequence for all users,
-- because the MVP runs on one PayPal account and numbers are unique per account.
--
-- minimum_due_cents: deposits accept partial payments with this smallest first payment.
-- milestone_status_before: the milestone's status when it was invoiced, restored on cancel.

CREATE SEQUENCE public.invoice_number_seq;
GRANT USAGE ON SEQUENCE public.invoice_number_seq TO authenticated, service_role;

ALTER TABLE public.invoices
  ADD COLUMN invoice_number text NOT NULL UNIQUE
    DEFAULT 'FPR-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
  ADD COLUMN minimum_due_cents bigint CHECK (minimum_due_cents > 0),
  ADD COLUMN milestone_status_before text CHECK (milestone_status_before IN (
    'planned', 'in_progress', 'delivered', 'accepted'
  )),
  ADD CONSTRAINT invoices_minimum_within_amount
    CHECK (minimum_due_cents IS NULL OR minimum_due_cents <= amount_cents);

COMMENT ON COLUMN public.invoices.invoice_number IS 'Sent to PayPal as detail.invoice_number; PayPal refuses duplicates, so retries never create a second invoice.';
COMMENT ON COLUMN public.invoices.minimum_due_cents IS 'Deposits: smallest first payment PayPal accepts (partial payments are on for every invoice).';
COMMENT ON COLUMN public.invoices.milestone_status_before IS 'Milestone status before it was invoiced; restored if the invoice is cancelled.';
