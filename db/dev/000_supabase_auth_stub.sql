-- DEV ONLY. Never apply this to Supabase, which already has all of it.
-- Gives plain local Postgres what Supabase provides, so RLS policies in db/migrations are written
-- exactly as they would be on Supabase:
--   * roles anon, authenticated and service_role (service_role bypasses RLS)
--   * auth.users (minimal) and auth.uid(), which reads `sub` from the request.jwt.claims setting
-- Apply with `npm run db:dev-auth`, which refuses any non-local DATABASE_URL (scripts/lib/local-db.ts).
-- service_role is for n8n and webhook handlers only, never for user-facing dashboard code.
-- Safe to re-run.

-- Refuse to overwrite a real auth.uid(): the stub marks its own function with this comment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
      AND p.proname = 'uid'
      AND coalesce(obj_description(p.oid, 'pg_proc'), '') <> 'fpr-dev-stub'
  ) THEN
    RAISE EXCEPTION 'auth.uid() already exists and is not the dev stub. This looks like a real Supabase database; refusing to overwrite it.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text
);

-- Reads request.jwt.claims only (no fallback to the legacy request.jwt.claim.sub setting).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

COMMENT ON FUNCTION auth.uid() IS 'fpr-dev-stub';

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;
