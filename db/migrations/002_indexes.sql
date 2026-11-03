-- 002_indexes: an index on every foreign key and on the user_id filter used by every RLS policy.
-- Already covered by a unique constraint, so no extra index:
--   users.id (primary key), ai_providers.user_id (user_id, task, fallback_order),
--   milestones.project_id (project_id, position).
-- Indexes for the scheduler's own queries come in a later migration, with the scheduler (M1+).

CREATE INDEX clients_user_id_idx ON public.clients (user_id);

CREATE INDEX projects_user_id_idx ON public.projects (user_id);
CREATE INDEX projects_client_id_idx ON public.projects (client_id);

CREATE INDEX milestones_user_id_idx ON public.milestones (user_id);

CREATE INDEX retainers_user_id_idx ON public.retainers (user_id);
CREATE INDEX retainers_client_id_idx ON public.retainers (client_id);
CREATE INDEX retainers_project_id_idx ON public.retainers (project_id);

CREATE INDEX maintenance_tasks_user_id_idx ON public.maintenance_tasks (user_id);
CREATE INDEX maintenance_tasks_project_id_idx ON public.maintenance_tasks (project_id);

CREATE INDEX invoices_user_id_idx ON public.invoices (user_id);
CREATE INDEX invoices_milestone_id_idx ON public.invoices (milestone_id);
CREATE INDEX invoices_retainer_id_idx ON public.invoices (retainer_id);

CREATE INDEX reminders_user_id_idx ON public.reminders (user_id);
CREATE INDEX reminders_invoice_id_idx ON public.reminders (invoice_id);

CREATE INDEX messages_user_id_idx ON public.messages (user_id);
CREATE INDEX messages_invoice_id_idx ON public.messages (invoice_id);

CREATE INDEX events_user_id_idx ON public.events (user_id);
