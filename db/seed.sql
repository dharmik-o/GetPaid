-- Demo data (fake only). Local databases only: `npm run db:seed` refuses any other host.
-- The demo freelancer below is the dev user the dashboard acts as (apps/web/src/lib/auth.ts).
-- The client and project are the ones in the spec's demo plan (docs/DEMO.md is the script).
-- Safe to re-run: it adds what's missing and leaves anything you've changed.

INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-4000-8000-000000000001', 'demo.freelancer@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, name, email, time_zone)
VALUES ('00000000-0000-4000-8000-000000000001', 'Demo Freelancer', 'demo.freelancer@example.test', 'Asia/Kolkata')
ON CONFLICT (id) DO NOTHING;

-- Days saved compares against this. It's the demo freelancer's own (fake) figure.
UPDATE public.users SET usual_days_late = 30
WHERE id = '00000000-0000-4000-8000-000000000001' AND usual_days_late IS NULL;

INSERT INTO public.clients (id, user_id, name, email, country, time_zone)
VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001',
  'Hudson Street Bakery', 'hudson-street-bakery@example.test', 'US', 'America/New_York')
ON CONFLICT (id) DO NOTHING;

-- Net 7, a reminder every 3 days, 9:00 to 17:00 client time. All seven days, so a demo on any day
-- of the week can send, and no courtesy note, so nothing is waiting before the clock jumps.
INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, settings)
VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000c1', 'Website redesign', 300000, 'USD',
  '{"paymentTerms": {"kind": "net", "days": 7},
    "interval": {"kind": "every", "days": 3},
    "preDueDays": null,
    "sendWindow": {"days": [1, 2, 3, 4, 5, 6, 7], "start": "09:00", "end": "17:00"}}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, deliverable, percent_bp, deadline, payment_mode)
VALUES
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d1', 'USD', 1, 'Design', 'Approved homepage design', 3000,
    current_date + 14, 'deposit'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d1', 'USD', 2, 'Build', 'Working site on staging', 5000,
    current_date + 28, 'pay_on_invoice'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d1', 'USD', 3, 'Launch', 'Live site and handover', 2000,
    current_date + 42, 'pay_on_invoice')
ON CONFLICT (id) DO NOTHING;
