# Setup guide

Step-by-step: env vars, docker compose up, import n8n workflows, connect PayPal sandbox, Gmail, Telegram bot, AI provider.

## Local stack

1. Copy `.env.example` to `.env` at the repo root and fill in `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY` and `LITELLM_MASTER_KEY` (it must start with `sk-`). Keep `DATABASE_URL` in step with the Postgres values.
2. Start Docker Desktop, then run `docker compose up -d --wait`. The command returns only when every health check passes, and fails otherwise.
3. For a local model, add the profile: `docker compose --profile ollama up -d --wait`.

| Service  | URL                    | Health check                     |
| -------- | ---------------------- | -------------------------------- |
| Postgres | `localhost:5432`       | `pg_isready`                     |
| n8n      | http://localhost:5678  | `GET /healthz`                   |
| LiteLLM  | http://localhost:4000  | `GET /health/liveliness`         |
| Ollama   | http://localhost:11434 | `ollama list` (profile `ollama`) |

All ports bind to `127.0.0.1`. `docker compose ps` shows each service's health; `docker compose down` stops the stack and keeps the data volumes.

## Database (local)

With the stack up, run these once, in order:

1. `npm run db:dev-auth`: adds what Supabase provides to plain Postgres (`auth.uid()`, the `anon`, `authenticated` and `service_role` roles). Dev only: it refuses any `DATABASE_URL` that isn't local, including `*.supabase.co` and `*.supabase.com`. Safe to re-run.
2. `npm run db:migrate`: applies `db/migrations/*.sql` in order, each in its own transaction, and records them in `schema_migrations`. A re-run applies only new files.
3. `npm run db:seed`: loads `db/seed.sql`.

Tests: `npm test` runs the schema and RLS tests on an in-memory Postgres (PGlite), so it doesn't need Docker. `npm run test:db:docker` runs the same RLS isolation tests against the Docker Postgres in a throwaway database that is dropped afterwards.

Roles: the dashboard acts as `authenticated` (row-level security applies). `service_role` bypasses RLS and is only for n8n and webhook handlers, never for user-facing dashboard code.
