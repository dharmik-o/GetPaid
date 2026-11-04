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

## Server environment

The dashboard checks its environment when it starts and refuses to run if something is missing or invalid. Today that's `ENCRYPTION_KEY` (32 bytes, generate with `openssl rand -hex 32`) and `DATABASE_URL`. Run `npm run env:check` to see the same result without starting the server; it prints variable names only, never values. Keep `ENCRYPTION_KEY` safe and unchanged: if it changes, stored API keys and tokens can't be decrypted and must be entered again.

## Google OAuth client for Gmail

Needed before any real send or reply check.

1. Open https://console.cloud.google.com/ and create a project, or pick one (for example "Payment Recovery").
2. Go to **APIs & Services > Library**, search for **Gmail API**, and press **Enable**.
3. Go to **APIs & Services > OAuth consent screen** (shown as **Google Auth Platform** on newer consoles). Pick **External**, fill in the app name and your email, and save.
4. On **Data access** (or **Scopes**), add `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.readonly`.
5. On **Audience** (or **Test users**), leave it in **Testing**, and add the Gmail address you'll send from as a test user.
6. Go to **Clients** (or **Credentials > Create credentials > OAuth client ID**). Pick **Web application**, and add this exact **Authorized redirect URI**: `http://localhost:3000/api/integrations/gmail/callback`.
7. Copy the client ID and secret into your local env file as `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
8. Set `DEV_EMAIL_ALLOWLIST` to the addresses a dev send may go to, comma-separated, such as a second inbox of your own. Empty means nothing sends. Don't list a client you don't mean to email.
9. Restart the dev server, then press **Connect Gmail** in Settings > Integrations. Google warns the app isn't verified, which is expected in Testing: choose **Advanced > Go to app**.
10. Testing mode ends the connection after 7 days. When it does, sends are held and you're told on Telegram and in the dashboard to reconnect.
