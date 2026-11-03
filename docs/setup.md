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
