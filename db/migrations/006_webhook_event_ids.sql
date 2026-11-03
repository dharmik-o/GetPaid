-- 006_webhook_event_ids: each PayPal webhook event is applied once.
-- PayPal retries deliveries until it gets a 2xx, so the same event can arrive more than once,
-- even at the same time. The handler records the event id in the audit log inside the same
-- transaction as its changes; this index makes a second copy find the first and stop.

CREATE UNIQUE INDEX events_paypal_event_id
  ON public.events ((payload ->> 'paypalEventId'))
  WHERE payload ->> 'paypalEventId' IS NOT NULL;
