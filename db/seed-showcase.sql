-- Showcase data for the public demo (fake only): four more clients in four countries and
-- currencies, with projects in every state, so the dashboard looks lived-in. Run it after
-- db/seed.sql with `npm run db:seed:showcase`. Local databases only, like the seed.
--
-- These invoices are history: their PayPal ids and pay links are made up, so they can't be paid,
-- cancelled or recorded in PayPal. The live PayPal flow is the seed's "Website redesign" project
-- (docs/DEMO.md). Client addresses end in example.test, so no email to them is ever sent, and the
-- invoices have no Gmail thread, so the reply listener never asks Gmail about them.
--
-- Safe to re-run: every row has a fixed id and is skipped if it's already there.

BEGIN;

-- ---------------------------------------------------------------- clients

INSERT INTO public.clients (id, user_id, name, email, country, time_zone, company, created_at)
VALUES
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001',
    'Kiez Coffee Roasters', 'kiez-coffee@example.test', 'DE', 'Europe/Berlin',
    'Kiez Coffee Roasters GmbH', now() - interval '95 days'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000001',
    'Harbour & Pine Architects', 'harbour-pine@example.test', 'GB', 'Europe/London',
    'Harbour & Pine Architects Ltd', now() - interval '60 days'),
  ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000001',
    'Wattle Wellness', 'wattle-wellness@example.test', 'AU', 'Australia/Sydney',
    'Wattle Wellness Pty Ltd', now() - interval '50 days'),
  ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-000000000001',
    'Maple Leaf Media', 'maple-leaf-media@example.test', 'CA', 'America/Toronto',
    'Maple Leaf Media Inc.', now() - interval '80 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- projects

-- Net 14, a reminder every 7 days, 9:00 to 17:00 client time on weekdays.
INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline, status,
  late_fee_clause, settings, created_at)
VALUES
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000c2', 'Brand identity and packaging', 240000, 'EUR',
    current_date - 20, 'completed', NULL,
    '{"paymentTerms": {"kind": "net", "days": 14}, "interval": {"kind": "every", "days": 7},
      "sendWindow": {"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00"}}',
    now() - interval '95 days'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000c3', 'Studio website', 400000, 'GBP',
    current_date + 30, 'active', NULL,
    '{"paymentTerms": {"kind": "net", "days": 14}, "interval": {"kind": "every", "days": 7},
      "sendWindow": {"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00"}}',
    now() - interval '60 days'),
  ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000c4', 'Booking app MVP', 600000, 'AUD',
    current_date + 45, 'active', NULL,
    '{"paymentTerms": {"kind": "net", "days": 14}, "interval": {"kind": "every", "days": 7},
      "sendWindow": {"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00"}}',
    now() - interval '50 days'),
  ('00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000c5', 'Podcast network website', 500000, 'CAD',
    current_date + 20, 'active',
    'Invoices unpaid 30 days after the due date incur a late fee of 1.5% of the unpaid amount per month.',
    '{"paymentTerms": {"kind": "net", "days": 14}, "interval": {"kind": "every", "days": 7},
      "sendWindow": {"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00"}}',
    now() - interval '80 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- milestones

INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, deliverable,
  percent_bp, deadline, payment_mode, status, created_at)
VALUES
  -- Kiez: finished and fully paid.
  ('00000000-0000-4000-8000-000000000f21', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d2', 'EUR', 1, 'Logo and brand guidelines',
    'Logo suite and a 20-page brand book', 5000, current_date - 70, 'pay_on_invoice', 'paid',
    now() - interval '95 days'),
  ('00000000-0000-4000-8000-000000000f22', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d2', 'EUR', 2, 'Packaging design',
    'Print-ready bag and label artwork', 5000, current_date - 25, 'pay_on_invoice', 'paid',
    now() - interval '95 days'),
  -- Harbour & Pine: deposit paid, the build invoice is late and the client has replied.
  ('00000000-0000-4000-8000-000000000f31', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d3', 'GBP', 1, 'Discovery and design',
    'Approved page designs', 4000, current_date - 35, 'deposit', 'paid',
    now() - interval '60 days'),
  ('00000000-0000-4000-8000-000000000f32', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d3', 'GBP', 2, 'Build',
    'Working site on staging', 4000, current_date - 26, 'pay_on_invoice', 'invoiced',
    now() - interval '60 days'),
  ('00000000-0000-4000-8000-000000000f33', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d3', 'GBP', 3, 'Launch and handover',
    'Live site, training and handover notes', 2000, current_date + 30, 'pay_on_invoice', 'planned',
    now() - interval '60 days'),
  -- Wattle: first milestone paid by bank transfer, the beta invoice just went overdue.
  ('00000000-0000-4000-8000-000000000f41', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d4', 'AUD', 1, 'Clickable prototype',
    'Figma prototype of the booking flow', 3000, current_date - 34, 'pay_on_invoice', 'paid',
    now() - interval '50 days'),
  ('00000000-0000-4000-8000-000000000f42', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d4', 'AUD', 2, 'Beta build',
    'Beta build on TestFlight', 4000, current_date - 17, 'pay_on_invoice', 'invoiced',
    now() - interval '50 days'),
  ('00000000-0000-4000-8000-000000000f43', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d4', 'AUD', 3, 'App store launch',
    'App live on the App Store and Google Play', 3000, current_date + 45, 'pay_on_invoice',
    'in_progress', now() - interval '50 days'),
  -- Maple Leaf: long overdue, with a final notice waiting for approval.
  ('00000000-0000-4000-8000-000000000f51', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d5', 'CAD', 1, 'Site build and migration',
    'New site live with 400 episodes migrated', 6000, current_date - 52, 'pay_on_invoice',
    'invoiced', now() - interval '80 days'),
  ('00000000-0000-4000-8000-000000000f52', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000d5', 'CAD', 2, 'Hosting handover',
    'Hosting moved to the client''s account', 4000, current_date + 20, 'pay_on_invoice',
    'in_progress', now() - interval '80 days')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- invoices

INSERT INTO public.invoices (id, user_id, milestone_id, paypal_invoice_id, link, amount_cents,
  amount_paid_cents, currency, due_date, status, created_at, paid_at, milestone_status_before)
VALUES
  ('00000000-0000-4000-8000-000000000a21', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f21', 'INV2-DEMO-KIEZ-0001',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-KIEZ-0001', 120000, 120000, 'EUR',
    current_date - 56, 'paid', now() - interval '70 days', now() - interval '53 days', 'delivered'),
  ('00000000-0000-4000-8000-000000000a22', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f22', 'INV2-DEMO-KIEZ-0002',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-KIEZ-0002', 120000, 120000, 'EUR',
    current_date - 11, 'paid', now() - interval '25 days', now() - interval '6 days', 'delivered'),
  ('00000000-0000-4000-8000-000000000a31', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f31', 'INV2-DEMO-HARB-0001',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-HARB-0001', 160000, 160000, 'GBP',
    current_date - 46, 'paid', now() - interval '60 days', now() - interval '58 days', 'planned'),
  ('00000000-0000-4000-8000-000000000a32', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f32', 'INV2-DEMO-HARB-0002',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-HARB-0002', 160000, 0, 'GBP',
    current_date - 12, 'sent', now() - interval '26 days', NULL, 'delivered'),
  ('00000000-0000-4000-8000-000000000a41', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f41', 'INV2-DEMO-WATT-0001',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-WATT-0001', 180000, 180000, 'AUD',
    current_date - 20, 'paid', now() - interval '34 days', now() - interval '18 days', 'delivered'),
  ('00000000-0000-4000-8000-000000000a42', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f42', 'INV2-DEMO-WATT-0002',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-WATT-0002', 240000, 0, 'AUD',
    current_date - 3, 'sent', now() - interval '17 days', NULL, 'delivered'),
  ('00000000-0000-4000-8000-000000000a51', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000f51', 'INV2-DEMO-MAPL-0001',
    'https://www.sandbox.paypal.com/invoice/p/#INV2-DEMO-MAPL-0001', 300000, 0, 'CAD',
    current_date - 38, 'sent', now() - interval '52 days', NULL, 'delivered')
ON CONFLICT DO NOTHING;

-- Harbour & Pine replied, which holds that invoice's reminders until the freelancer decides.
UPDATE public.invoices SET reminders_held_at = now() - interval '1 day'
WHERE id = '00000000-0000-4000-8000-000000000a32' AND status = 'sent' AND reminders_held_at IS NULL;

-- Wattle's first invoice was paid by bank transfer and recorded by hand.
INSERT INTO public.invoice_payments (id, user_id, invoice_id, method, amount_cents, currency,
  received_on, reference, paypal_payment_id, recorded_by, created_at)
VALUES
  ('00000000-0000-4000-8000-000000000881', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000a41', 'bank_transfer', 180000, 'AUD', current_date - 18,
    'Westpac transfer 4471', 'DEMO-PAYMENT-WATT-0001', '00000000-0000-4000-8000-000000000001',
    now() - interval '18 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- reminders and emails

-- The drafts follow the app's own wording (lib/draft-templates.ts), with each invoice's number.
CREATE TEMP TABLE showcase_inv ON COMMIT DROP AS
SELECT id, invoice_number AS num, due_date, link FROM public.invoices
WHERE id IN ('00000000-0000-4000-8000-000000000a22', '00000000-0000-4000-8000-000000000a32',
  '00000000-0000-4000-8000-000000000a42', '00000000-0000-4000-8000-000000000a51');

CREATE TEMP TABLE showcase_drafts ON COMMIT DROP AS
SELECT * FROM (VALUES
  -- Kiez: one friendly reminder, then they paid.
  ('00000000-0000-4000-8000-000000000b21'::uuid, '00000000-0000-4000-8000-000000000a22'::uuid,
    'tier1', 9, true, 'telegram',
    'Friendly reminder: invoice %1$s for Brand identity and packaging',
    E'Hi Kiez Coffee Roasters,\n\nI hope the print-ready bag and label artwork is working well for you. Let me know if anything needs a look.\n\nA quick reminder that invoice %1$s (EUR 1,200.00) was due on %2$s.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model'),
  -- Harbour & Pine: one reminder, then the client replied.
  ('00000000-0000-4000-8000-000000000b31', '00000000-0000-4000-8000-000000000a32',
    'tier1', 10, true, 'outbox',
    'Friendly reminder: invoice %1$s for Studio website',
    E'Hi Harbour & Pine Architects,\n\nI hope the staging site is working well for you. Let me know if anything needs a look.\n\nA quick reminder that invoice %1$s (GBP 1,600.00) was due on %2$s.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model'),
  -- Wattle: a first reminder waiting in the Outbox.
  ('00000000-0000-4000-8000-000000000b41', '00000000-0000-4000-8000-000000000a42',
    'tier1', -1, false, NULL,
    'Friendly reminder: invoice %1$s for Booking app MVP',
    E'Hi Wattle Wellness,\n\nI hope the beta build on TestFlight is working well for you. Let me know if anything needs a look.\n\nA quick reminder that invoice %1$s (AUD 2,400.00) was due on %2$s.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model'),
  -- Maple Leaf: two reminders sent, a final notice waiting.
  ('00000000-0000-4000-8000-000000000b51', '00000000-0000-4000-8000-000000000a51',
    'tier1', 36, true, 'telegram',
    'Friendly reminder: invoice %1$s for Podcast network website',
    E'Hi Maple Leaf Media,\n\nI hope the new site and the migrated episodes are working well for you. Let me know if anything needs a look.\n\nA quick reminder that invoice %1$s (CAD 3,000.00) was due on %2$s.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model'),
  ('00000000-0000-4000-8000-000000000b52', '00000000-0000-4000-8000-000000000a51',
    'tier2', 22, true, 'outbox',
    'Overdue: invoice %1$s for Podcast network website',
    E'Hi Maple Leaf Media,\n\nInvoice %1$s (CAD 3,000.00) was due on %2$s and is now 16 days overdue. Our agreed payment terms are Net 14.\n\nIf paying it all at once is difficult, reply to this email and we can split the remaining amount into installments.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model'),
  ('00000000-0000-4000-8000-000000000b53', '00000000-0000-4000-8000-000000000a51',
    'tier3', -1, false, NULL,
    'Final notice: invoice %1$s',
    E'Hi Maple Leaf Media,\n\nThis is a final notice for invoice %1$s (CAD 3,000.00), which was due on %2$s and is now 38 days overdue. I''ve sent earlier reminders about it. Our agreed payment terms are Net 14.\n\nOur contract''s late-payment clause says: "Invoices unpaid 30 days after the due date incur a late fee of 1.5%% of the unpaid amount per month."\n\nPlease pay the invoice now, or reply to this email so we can agree a plan.\n\nYou can pay it here:\n%3$s\n\nThanks,\nDemo Freelancer',
    'model')
) AS d(id, invoice_id, tier, days_ago, sent, approved_via, subject, body, via);

-- days_ago: when it was sent; -1: waiting, due to go out tomorrow at 10:00 the client's time.
INSERT INTO public.reminders (id, user_id, invoice_id, tier, scheduled_at, draft, approval_status,
  approved_via, sent_at, created_at)
SELECT d.id, '00000000-0000-4000-8000-000000000001', d.invoice_id, d.tier,
  CASE WHEN d.sent THEN now() - make_interval(days => d.days_ago)
       ELSE ((current_date + 1) + time '10:00') AT TIME ZONE c.time_zone END,
  jsonb_build_object(
    'subject', format(d.subject, i.num),
    'body', format(d.body, i.num, to_char(i.due_date, 'FMDD Mon YYYY'), i.link),
    'kind', d.tier,
    'via', d.via,
    'model', 'gemini-3.5-flash-lite',
    'isLocal', false,
    'citation', CASE WHEN d.tier = 'tier3' THEN 'contract' END,
    'lawId', NULL,
    'notLegalAdvice', d.tier = 'tier3',
    'draftedAt', to_char(
      (CASE WHEN d.sent THEN now() - make_interval(days => d.days_ago) - interval '2 hours'
            ELSE now() - interval '3 hours' END) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  CASE WHEN d.sent THEN 'approved' ELSE 'waiting' END,
  CASE WHEN d.sent THEN d.approved_via END,
  CASE WHEN d.sent THEN now() - make_interval(days => d.days_ago) END,
  CASE WHEN d.sent THEN now() - make_interval(days => d.days_ago) - interval '2 hours'
       ELSE now() - interval '3 hours' END
FROM showcase_drafts d
JOIN showcase_inv i ON i.id = d.invoice_id
JOIN public.invoices inv ON inv.id = d.invoice_id
JOIN public.milestones m ON m.id = inv.milestone_id
JOIN public.projects p ON p.id = m.project_id
JOIN public.clients c ON c.id = p.client_id
ON CONFLICT DO NOTHING;

-- The emails that went out, as the sender records them.
INSERT INTO public.messages (id, user_id, invoice_id, direction, body, created_at)
SELECT ('00000000-0000-4000-8000-0000000005' || right(d.id::text, 2))::uuid,
  '00000000-0000-4000-8000-000000000001', d.invoice_id, 'out',
  format(d.body, i.num, to_char(i.due_date, 'FMDD Mon YYYY'), i.link),
  now() - make_interval(days => d.days_ago)
FROM showcase_drafts d JOIN showcase_inv i ON i.id = d.invoice_id
WHERE d.sent
ON CONFLICT DO NOTHING;

-- Harbour & Pine's reply, sorted by the AI and waiting for the freelancer in Replies.
INSERT INTO public.messages (id, user_id, invoice_id, direction, body, ai_classification,
  review_status, created_at)
VALUES ('00000000-0000-4000-8000-000000000599', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000a32', 'in',
  E'Hi,\n\nSorry for the delay on this one. Our accounts team only runs supplier payments at the end of the week, and this invoice missed the last run. It''s approved now and will go out on '
    || to_char(current_date + 6, 'FMDay FMDD Mon') || E'.\n\nBest,\nEleanor\nHarbour & Pine Architects',
  jsonb_build_object(
    'label', 'promise',
    'promisedDate', to_char(current_date + 6, 'YYYY-MM-DD'),
    'returnDate', NULL,
    'summary', 'Says the invoice is approved and will be paid on ' || to_char(current_date + 6, 'FMDD Mon') || '.'),
  'pending', now() - interval '1 day')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- maintenance

INSERT INTO public.maintenance_tasks (id, user_id, project_id, type, task, repeat_months, next_due,
  est_cost_cents, currency, checklist, created_at)
VALUES ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000d5', 'renewal', 'Domain and SSL certificate renewal', 12,
  current_date + 40, 4500, 'CAD', '["Renew the domain", "Check the SSL certificate"]',
  now() - interval '40 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- timeline

INSERT INTO public.events (id, user_id, entity, entity_id, type, payload, created_at)
SELECT e.id, '00000000-0000-4000-8000-000000000001', e.entity, e.entity_id, e.type, e.payload::jsonb,
  now() - make_interval(days => e.days_ago)
FROM (VALUES
  ('00000000-0000-4000-8000-000000000601'::uuid, 'invoice', '00000000-0000-4000-8000-000000000a21'::uuid, 'invoice.sent', '{}', 70),
  ('00000000-0000-4000-8000-000000000602', 'invoice', '00000000-0000-4000-8000-000000000a21', 'invoice.paid', '{"amountPaidCents": 120000, "eventType": "INVOICING.INVOICE.PAID"}', 53),
  ('00000000-0000-4000-8000-000000000603', 'invoice', '00000000-0000-4000-8000-000000000a22', 'invoice.sent', '{}', 25),
  ('00000000-0000-4000-8000-000000000604', 'reminder', '00000000-0000-4000-8000-000000000b21', 'reminder.sent', '{"tier": "tier1", "onThread": false}', 9),
  ('00000000-0000-4000-8000-000000000605', 'invoice', '00000000-0000-4000-8000-000000000a22', 'invoice.paid', '{"amountPaidCents": 120000, "eventType": "INVOICING.INVOICE.PAID"}', 6),
  ('00000000-0000-4000-8000-000000000606', 'invoice', '00000000-0000-4000-8000-000000000a31', 'invoice.sent', '{}', 60),
  ('00000000-0000-4000-8000-000000000607', 'invoice', '00000000-0000-4000-8000-000000000a31', 'invoice.paid', '{"amountPaidCents": 160000, "eventType": "INVOICING.INVOICE.PAID"}', 58),
  ('00000000-0000-4000-8000-000000000608', 'invoice', '00000000-0000-4000-8000-000000000a32', 'invoice.sent', '{}', 26),
  ('00000000-0000-4000-8000-000000000609', 'reminder', '00000000-0000-4000-8000-000000000b31', 'reminder.sent', '{"tier": "tier1", "onThread": false}', 10),
  ('00000000-0000-4000-8000-000000000610', 'invoice', '00000000-0000-4000-8000-000000000a32', 'reply.received', '{"label": "promise"}', 1),
  ('00000000-0000-4000-8000-000000000611', 'invoice', '00000000-0000-4000-8000-000000000a41', 'invoice.sent', '{}', 34),
  ('00000000-0000-4000-8000-000000000612', 'invoice', '00000000-0000-4000-8000-000000000a41', 'payment.recorded', '{"method": "bank_transfer", "amountCents": 180000}', 18),
  ('00000000-0000-4000-8000-000000000613', 'invoice', '00000000-0000-4000-8000-000000000a41', 'invoice.paid', '{"amountPaidCents": 180000, "eventType": "payment.recorded"}', 18),
  ('00000000-0000-4000-8000-000000000614', 'invoice', '00000000-0000-4000-8000-000000000a42', 'invoice.sent', '{}', 17),
  ('00000000-0000-4000-8000-000000000615', 'invoice', '00000000-0000-4000-8000-000000000a51', 'invoice.sent', '{}', 52),
  ('00000000-0000-4000-8000-000000000616', 'reminder', '00000000-0000-4000-8000-000000000b51', 'reminder.sent', '{"tier": "tier1", "onThread": false}', 36),
  ('00000000-0000-4000-8000-000000000617', 'reminder', '00000000-0000-4000-8000-000000000b52', 'reminder.sent', '{"tier": "tier2", "onThread": false}', 22)
) AS e(id, entity, entity_id, type, payload, days_ago)
ON CONFLICT DO NOTHING;

COMMIT;
