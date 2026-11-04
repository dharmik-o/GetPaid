-- The freelancer's own time zone, so the Outbox can show each send time in both zones.
-- Existing users start on UTC, which the card names, until they pick theirs in Settings.
ALTER TABLE public.users ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';
COMMENT ON COLUMN public.users.time_zone IS 'IANA zone, for display only. Send windows use clients.time_zone.';
