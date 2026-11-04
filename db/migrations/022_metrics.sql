-- 022_metrics: what the recovery metrics need.
--
-- paid_at: when an invoice turned paid. Set by the database, so every path that records a payment
-- (webhook, hold capture, the retainer check) is covered, and the first date stands through a refund.
-- usual_days_late: how late the freelancer's clients usually paid before using the app, in their
-- own words. "Days saved" compares against it, and isn't shown without it.

ALTER TABLE public.invoices ADD COLUMN paid_at timestamptz;
COMMENT ON COLUMN public.invoices.paid_at IS 'When it first turned paid. Set by a trigger; a refund keeps it.';

ALTER TABLE public.users
  ADD COLUMN usual_days_late smallint CHECK (usual_days_late BETWEEN 0 AND 365);
COMMENT ON COLUMN public.users.usual_days_late IS 'Self-reported baseline for days saved. NULL means unknown: nothing is assumed.';

-- Invoices already paid: the event that recorded it, or failing that the last change to the row.
UPDATE public.invoices i
SET paid_at = coalesce(
  (SELECT min(e.created_at) FROM public.events e
   WHERE e.entity = 'invoice' AND e.entity_id = i.id AND e.type = 'invoice.paid'),
  i.updated_at)
WHERE i.status = 'paid';

CREATE FUNCTION public.set_invoice_paid_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status <> 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_set_paid_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_invoice_paid_at();
