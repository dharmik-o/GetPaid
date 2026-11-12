-- 034_project_archive: E2, archiving a project. An archived project is hidden from the Projects
-- list (until "Show archived" is on), from Home and from the client's page, and nothing more is
-- planned or sent for it. All its records stay, and Restore clears the column.
--
-- Kept apart from `status` on purpose: a project can be Completed and archived, and restoring it
-- must bring back exactly the status it had.

ALTER TABLE public.projects ADD COLUMN archived_at timestamptz;
COMMENT ON COLUMN public.projects.archived_at IS 'When the freelancer archived it; NULL while it is shown. Archived projects plan no new reminders.';
