-- 035_ai_help_task: E3, the "Ask GetPaid" help assistant is a fifth AI task, so a user can give it
-- its own model. Users who saved their AI settings before this have no 'help' rows: the app then
-- uses the 'draft' task's rows (their main model), so nothing breaks (lib/help-assistant.ts). With
-- no model at all it says to set one: there is no template fallback for an answer.

ALTER TABLE public.ai_providers
  DROP CONSTRAINT ai_providers_task_check,
  ADD CONSTRAINT ai_providers_task_check CHECK (task IN ('sort', 'draft', 'tier3', 'calendar', 'help'));
