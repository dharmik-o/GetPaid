-- 027_calendar: Phase 2 part A. The freelancer's own entries, imported calendars and their events.
-- App-made dates are not stored here: the calendar reads them from their own tables (F2).

CREATE TABLE public.calendar_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  notes text CHECK (char_length(notes) <= 5000),
  kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'event', 'deadline', 'call')),
  starts_on date NOT NULL,
  ends_on date,                          -- all-day entries over several days; NULL = one day
  start_time time,                       -- NULL = all day
  end_time time,
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),  -- IANA, checked in code
  client_id uuid,
  project_id uuid,
  milestone_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at timestamptz,
  remind_on_day boolean NOT NULL DEFAULT false,
  telegram_notified_at timestamptz,
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
  created_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  updated_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  UNIQUE (id, user_id),
  CONSTRAINT calendar_entries_client_fkey FOREIGN KEY (client_id, user_id)
    REFERENCES public.clients (id, user_id) ON DELETE SET NULL (client_id),
  CONSTRAINT calendar_entries_project_fkey FOREIGN KEY (project_id, user_id)
    REFERENCES public.projects (id, user_id) ON DELETE SET NULL (project_id),
  CONSTRAINT calendar_entries_milestone_fkey FOREIGN KEY (milestone_id, user_id)
    REFERENCES public.milestones (id, user_id) ON DELETE SET NULL (milestone_id),
  CONSTRAINT calendar_entries_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT calendar_entries_times CHECK (end_time IS NULL OR start_time IS NOT NULL),
  CONSTRAINT calendar_entries_timed_one_day CHECK (start_time IS NULL OR ends_on IS NULL),
  CONSTRAINT calendar_entries_end_after_start CHECK (end_time IS NULL OR end_time > start_time),
  CONSTRAINT calendar_entries_done CHECK ((status = 'done') = (done_at IS NOT NULL))
);
COMMENT ON TABLE public.calendar_entries IS 'The freelancer''s own calendar items. Milestone deadlines, invoice due dates and the like are read from their own tables, never copied here.';
COMMENT ON COLUMN public.calendar_entries.time_zone IS 'IANA zone the date and times are in; stored with the entry so it doesn''t move if the account zone changes.';
CREATE INDEX calendar_entries_user_day_idx ON public.calendar_entries (user_id, starts_on);
CREATE INDEX calendar_entries_client_id_idx ON public.calendar_entries (client_id);
CREATE INDEX calendar_entries_project_id_idx ON public.calendar_entries (project_id);
CREATE INDEX calendar_entries_milestone_id_idx ON public.calendar_entries (milestone_id);

CREATE TABLE public.calendar_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),       -- "Work (Google)"
  kind text NOT NULL CHECK (kind IN ('url', 'file')),
  url_enc text,                          -- encrypted iCal address (kind 'url' only)
  url_host text CHECK (char_length(url_host) <= 255),                  -- shown in the UI
  color text NOT NULL DEFAULT 'gray' CHECK (color IN ('gray', 'blue', 'green', 'purple', 'orange', 'pink')),
  enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_error text CHECK (last_error IN ('unreachable', 'not_ics', 'too_large', 'blocked_address', 'timeout', 'http_error')),
  event_count integer NOT NULL DEFAULT 0,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  UNIQUE (id, user_id),
  CONSTRAINT calendar_sources_url_kind CHECK ((kind = 'url') = (url_enc IS NOT NULL))
);
COMMENT ON COLUMN public.calendar_sources.url_enc IS 'The secret iCal address, encrypted (lib/crypto.ts). It grants read access to someone''s calendar: never returned to the browser, never logged.';
CREATE INDEX calendar_sources_user_id_idx ON public.calendar_sources (user_id);

CREATE TABLE public.calendar_events (     -- imported, read-only, replaced on every sync
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  uid text NOT NULL CHECK (char_length(uid) <= 255),
  occurrence_start timestamptz NOT NULL,  -- one row per occurrence of a recurring event
  occurrence_end timestamptz,
  all_day boolean NOT NULL,
  title text NOT NULL CHECK (char_length(title) <= 200),
  location text CHECK (char_length(location) <= 200),
  client_id uuid,                         -- set when an attendee email matches a client
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  UNIQUE (source_id, uid, occurrence_start),
  CONSTRAINT calendar_events_source_fkey FOREIGN KEY (source_id, user_id)
    REFERENCES public.calendar_sources (id, user_id) ON DELETE CASCADE,
  CONSTRAINT calendar_events_client_fkey FOREIGN KEY (client_id, user_id)
    REFERENCES public.clients (id, user_id) ON DELETE SET NULL (client_id)
);
COMMENT ON TABLE public.calendar_events IS 'Events read from imported calendars. Descriptions and attendee lists are not stored (privacy); only the matched client_id is kept.';
CREATE INDEX calendar_events_user_time_idx ON public.calendar_events (user_id, occurrence_start);
CREATE INDEX calendar_events_client_id_idx ON public.calendar_events (client_id);

CREATE TRIGGER calendar_entries_set_updated_at BEFORE UPDATE ON public.calendar_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.calendar_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY calendar_entries_owner ON public.calendar_entries FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY calendar_sources_owner ON public.calendar_sources FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY calendar_events_owner ON public.calendar_events FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.calendar_entries, public.calendar_sources, public.calendar_events
  FROM anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_entries, public.calendar_sources,
  public.calendar_events TO authenticated, service_role;
