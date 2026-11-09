-- 028_ai_calendar_task: Phase 2 part A, step A5. The calendar assistant is a fourth AI task, so a
-- user can give it its own model. Users who saved their AI settings before this have no 'calendar'
-- rows: the app then uses the 'draft' task's rows, so nothing breaks (lib/calendar-assistant.ts).

ALTER TABLE public.ai_providers
  DROP CONSTRAINT ai_providers_task_check,
  ADD CONSTRAINT ai_providers_task_check CHECK (task IN ('sort', 'draft', 'tier3', 'calendar'));
