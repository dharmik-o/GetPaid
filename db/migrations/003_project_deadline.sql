-- 003_project_deadline: a project's own delivery deadline.
-- A single-invoice project is due when the work is; with milestones, each milestone also has one.
-- Nullable so rows created before this migration stay valid; the dashboard API requires it.

ALTER TABLE public.projects ADD COLUMN deadline date;

COMMENT ON COLUMN public.projects.deadline IS 'Delivery deadline of the whole project (a calendar date). Required by the dashboard API.';
