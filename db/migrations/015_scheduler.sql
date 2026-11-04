-- The scheduler plans one reminder at a time per invoice: the next is worked out only once this one
-- is sent or skipped. The index makes that hold even if two runs overlap.
CREATE UNIQUE INDEX reminders_one_open_per_invoice
  ON public.reminders (invoice_id)
  WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved');
