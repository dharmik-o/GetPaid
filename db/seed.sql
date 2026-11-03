-- Demo data (fake only). Local databases only: `npm run db:seed` refuses any other host.
-- The demo freelancer below is the dev user the dashboard acts as (apps/web/src/lib/auth.ts).
-- The $3,000 website project with 3 milestones for a New York client is added in M10.
-- Safe to re-run.

INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-4000-8000-000000000001', 'demo.freelancer@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, name, email)
VALUES ('00000000-0000-4000-8000-000000000001', 'Demo Freelancer', 'demo.freelancer@example.test')
ON CONFLICT (id) DO NOTHING;
