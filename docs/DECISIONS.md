# Decisions

Choices made while building, newest last. Each entry: date, question, choice, why. Spec wording fixes are logged here too.

## M0 Foundations

### 2026-11-03: Repo tooling

- **Root package type:** `"type": "module"`. Vite warns that ESM config inside a CommonJS package will stop working; the `.mjs` hooks are unaffected.
- **Lint scope:** ESLint skips `.claude/**`. The hook scripts are harness tooling, and fixing their lint would mean editing the security hook.
- **Empty stub tests removed:** `tests/schedule.test.ts` and `tests/webhook-verify.test.ts` held no tests, and Vitest fails on those. M1 and M3 recreate them.
- **Migration runner:** `scripts/db.ts` with `pg` + `tsx` tracks applied files in `schema_migrations` and runs each file in its own transaction. It takes an advisory lock so two runs can't overlap.
- **`npm audit`:** one moderate advisory (`minimatch`, inside ESLint's own dependencies, dev only). Left as is, because the suggested `--force` fix downgrades ESLint to 4.0.0.

### 2026-11-03: Local stack

- **n8n state:** SQLite on the `n8n_data` volume, separate from the app's Postgres. Fewer moving parts; app data stays in its own database.
- **Ports:** every port binds to `127.0.0.1`. **Secrets:** use `${VAR:?message}`, so compose fails fast with a clear message when one is missing.
- **LiteLLM:** a minimal config with an offline `mock` model. Real providers come with the AI router (M4).
- **Ollama:** defined under the `ollama` profile; its runtime health check is deferred to M4 (agreed with the user).

### 2026-11-03: Database (approved by the user before the autonomous workflow began)

- **`auth.uid()` on plain Postgres:** a dev-only stub in `db/dev/` that mirrors Supabase. It reads `sub` from `request.jwt.claims` only, with no legacy fallback, and creates `anon`, `authenticated` and `service_role` (`BYPASSRLS`). `npm run db:dev-auth` refuses non-local hosts, `*.supabase.co` and `*.supabase.com`.
- **`service_role`:** only for n8n and webhook handlers, never user-facing dashboard code (in `.claude/rules/db.md` and `web.md`).
- **`user_id` on every table:** composite foreign keys `(parent_id, user_id)` stop a row from pointing at another user's data. Every RLS policy is `user_id = auth.uid()`.
- **`reminders.scheduled_at`:** `timestamptz` (a UTC instant). The send window is worked out in `clients.time_zone`. Spec wording updated to match.
- **Milestone percentages:** integer basis points (`percent_bp`, 30% = 3000). Exactly one of amount or percent is set. When converting, the last milestone absorbs the rounding remainder (built in M2).
- **`milestones.currency`:** added so every money column has a currency (db rule). A foreign key ties it to the project's currency.
- **Status values:**
  - projects: draft, active, completed, cancelled
  - retainers: pending_approval, active, suspended, cancelled, ended
  - maintenance tasks: active, cancelled, with `repeat_from` defaulting to `scheduled`
  - invoices: draft, sent, partially_paid, paid, cancelled, refunded, disputed
- **Schema tests:** run on PGlite (in-memory Postgres, no Docker needed for `npm run check`). `npm run test:db:docker` runs the same RLS suite on Docker Postgres. PGlite is Postgres 18.6 and Docker is 17.11.
- **`002_indexes`:** foreign-key and `user_id` indexes now; indexes for the scheduler's queries come in a later migration.
- **`docs/MVP-spec.md` is in `.prettierignore`:** the format hook was realigning every table in the exported spec.

### 2026-11-03: Secrets helper
- **Cipher:** AES-256-GCM (Node's built-in `crypto`), with a fresh 12-byte IV for every value. Stored as text, `v1:<iv>:<tag>:<ciphertext>` in base64url, for the `*_enc` columns. The `v1` prefix leaves room for key rotation later.
- **Context binding:** every encrypt and decrypt call needs a context string, for example `users.gmail_token_enc:<user id>`. It's authenticated as associated data, so a ciphertext copied to another row or column fails to decrypt.
- **`ENCRYPTION_KEY` format:** 32 bytes, as 64 hex characters or base64 (`openssl rand -hex 32`). Errors explain the format and never echo the value.
- **Startup check:** `apps/web/src/instrumentation.ts` runs the zod env check when the Next.js server starts. It was verified by hand: with `ENCRYPTION_KEY` empty, `next dev` exits 1 and names the variable. For now the schema covers `ENCRYPTION_KEY` and `DATABASE_URL`; later features add their own variables to `lib/env.ts`, and a test makes sure each is listed in `.env.example`.
- **One env file:** `next.config.mjs` loads the root env file with Node's `process.loadEnvFile`, so the dashboard, docker compose and the db scripts share one file. No new dependency; values already set in the shell win.
- **`npm run env:check`:** runs the same validation from the command line and prints only names and problems.
- **zod 4:** added to `apps/web`; CLAUDE.md requires zod for validation. No dependencies, no install scripts.
- **Next.js 16 `AGENTS.md`:** `next dev` writes `apps/web/AGENTS.md` by default; turned off with `agentRules: false`, since the project's rules live in CLAUDE.md. Its useful hint, kept here: Next 16 has breaking changes, so read `apps/web/node_modules/next/dist/docs/` before writing dashboard code (M2).
- **For M2:** `next dev` listens on every network interface by default (it printed a LAN address). Consider binding the dev server to `127.0.0.1`, as the compose stack does.

## M1 Schedule engine

### 2026-11-03: Settings merge
- **Where:** `apps/web/src/lib/settings.ts` holds the settings schema, the spec defaults and `mergeSettings()`, the one merge function. Timing rules stay in `lib/schedule.ts`.
- **What each layer stores:** only the settings it overrides (`users.default_settings`, then `clients`, `projects` and `milestones.settings`). Missing or null layers count as empty. A key set to `null` means "off" (pre-due reminder, late fee) and does override the layer above.
- **Grouped settings are replaced whole:** payment terms, interval, tier boundaries, send window and late fee come from a single layer, never mixed field by field. Mixing could produce tiers that don't ascend.
- **Pause and snooze combine instead of overriding:** a pause on any layer pauses, and the latest snooze date wins. Otherwise a stale `paused: false` on a project could resume reminders to a client the freelancer paused (for example during a dispute). Spec wording updated.
- **Not layered settings:** delivery deadline (a milestone column; projects get theirs in M2), client time zone (`clients.time_zone`) and currency (`projects.currency`) live on their own rows.
- **Shapes:** terms are `on_receipt`, `net` (7/14/30/45/60) or a specific `date`. Interval is `every N days` (1 to 90) or a list of dates. The send window is ISO weekdays (1 = Monday) plus `HH:MM` start and end in the client's zone. Late fee is basis points per month or flat `amountCents`. Dates are `YYYY-MM-DD`.
- **Ranges the spec leaves open:** pre-due 1 to 30 days, interval up to 90 days, tier starts 1 to 365 days overdue.
- **Strict parsing:** unknown or misspelled keys are rejected, and the error names the layer and field.
