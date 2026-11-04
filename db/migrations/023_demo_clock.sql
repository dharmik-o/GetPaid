-- 023_demo_clock: timestamps Postgres sets itself follow the app's demo clock.
--
-- The app sets app.demo_clock_offset_seconds inside a transaction only when its dev-only clock is
-- moved, so with nothing set (always, in production) this is exactly now(). Without it, a demo's
-- reminders would be dated days ahead and its replies and events today, out of order.

CREATE FUNCTION public.demo_clock_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT now() + make_interval(secs =>
    coalesce(nullif(current_setting('app.demo_clock_offset_seconds', true), ''), '0')::double precision)
$$;

ALTER TABLE public.events ALTER COLUMN created_at SET DEFAULT public.demo_clock_now();
ALTER TABLE public.messages ALTER COLUMN created_at SET DEFAULT public.demo_clock_now();
ALTER TABLE public.invoices ALTER COLUMN created_at SET DEFAULT public.demo_clock_now();
ALTER TABLE public.reminders ALTER COLUMN created_at SET DEFAULT public.demo_clock_now();

CREATE OR REPLACE FUNCTION public.set_invoice_paid_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status <> 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := public.demo_clock_now();
  END IF;
  RETURN NEW;
END;
$$;
