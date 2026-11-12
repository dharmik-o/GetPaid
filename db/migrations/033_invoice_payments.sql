-- 033_invoice_payments: E1, closing an invoice without PayPal. A signed-in freelancer can record
-- that a client paid by bank transfer, UPI, cash, cheque or another way. Each such payment is a
-- row here (source 'manual'), kept beside the invoice's own status, which still follows PayPal's
-- copy of the invoice after the payment is recorded there too.
--
-- Rows are append-only: the app can add one, never edit or delete it, so the record of what the
-- freelancer said they received can't be rewritten. A row goes only with its invoice.

CREATE TABLE public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  method text NOT NULL CHECK (method IN ('bank_transfer', 'upi', 'cash', 'cheque', 'wise', 'other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_on date NOT NULL,
  reference text CHECK (char_length(reference) <= 200),
  -- PayPal's id for the payment it recorded: one row per PayPal payment, however often it is retried.
  paypal_payment_id text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  UNIQUE (invoice_id, paypal_payment_id)
);
COMMENT ON TABLE public.invoice_payments IS 'Payments the freelancer recorded by hand (bank transfer, UPI, cash, cheque, other). Append-only.';
COMMENT ON COLUMN public.invoice_payments.paypal_payment_id IS 'The id PayPal gave the recorded payment, so a retry never counts it twice.';
CREATE INDEX invoice_payments_invoice_id_idx ON public.invoice_payments (invoice_id);
CREATE INDEX invoice_payments_user_id_idx ON public.invoice_payments (user_id);
CREATE INDEX invoice_payments_recorded_by_idx ON public.invoice_payments (recorded_by);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_payments_read ON public.invoice_payments FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY invoice_payments_insert ON public.invoice_payments FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND recorded_by = (SELECT auth.uid()));
REVOKE ALL ON public.invoice_payments FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.invoice_payments TO authenticated, service_role;
