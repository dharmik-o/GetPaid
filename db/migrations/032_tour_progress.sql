-- 032_tour_progress: T1 guided tour. Where each freelancer is with the walkthrough, kept on their
-- own users row, so the existing users_owner policy (row-level security) already keeps it private.
--   * tour_completed_at / tour_skipped_at: how the main tour ended (both empty = not seen yet)
--   * tour_tips_seen: the page tips already shown, by key (project, calendar, agreement, client)

ALTER TABLE public.users
  ADD COLUMN tour_completed_at timestamptz,
  ADD COLUMN tour_skipped_at timestamptz,
  ADD COLUMN tour_tips_seen text[] NOT NULL DEFAULT '{}';
