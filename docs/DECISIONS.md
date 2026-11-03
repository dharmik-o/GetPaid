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

### 2026-11-03: Next send time
- **Luxon** (`luxon` in `apps/web`, `@types/luxon` dev): CLAUDE.md names it as the one date library. No dependencies, no install scripts; `npm audit` shows only the existing `minimatch` advisory.
- **API:** `nextSend({ settings, dueDate, timeZone, history, now })` returns `scheduled` (tier and UTC `sendAt`), `paused` or `done`. `history` is the invoice's sent or skipped reminders; while one is still waiting for approval, the caller doesn't ask for the next. `computeDueDate(terms, issuedOn)` and `nextWindowSlot()` live here too.
- **Due date and day counting:** the due date is a calendar date in the client's time zone, and "day n overdue" counts the client's calendar days. Interval days run from the local date of the last reminder; the next one goes out at the window start on that date (or right away if it's already inside the window).
- **Courtesy note:** sent once, before any overdue reminder. If its day falls outside the window it moves to the next window slot, and it may land on the due date itself (still not overdue). If it can't land by the due date, it's dropped.
- **Grace period:** Tier 1 starts on day `max(tier 1 boundary, grace + 1)`. Grace delays only the start; Tier 2 and Tier 3 keep their boundaries.
- **Interval across tiers:** the interval is the minimum gap between any two overdue reminders, including when moving up a tier ("escalate after interval"), so a tier boundary can't cause two emails a day apart. The courtesy note doesn't count toward the gap.
- **Tier labels:** a reminder carries the tier for the day it actually goes out (after window and snooze shifts), and never a lower tier than the last one sent. After Tier 3 has had its max reminders, the schedule is `done`.
- **Specific dates:** each listed date is used once, in date order, from the first allowed overdue day. Dates already past are skipped. Max per tier doesn't apply, because the freelancer chose the dates.
- **Snooze:** reminders resume at the start of the snooze date in the client's zone, with the tier for that day.
- **DST:** a window start that doesn't exist on the change day (e.g. 02:30) moves to the first real time after it (Luxon's behaviour).

### 2026-11-03: Settings validation
- **Two places:** rules about one setting's shape (tiers ascend, window end after start, no repeated days, ranges) live in the zod schema in `lib/settings.ts`, so `mergeSettings` also rejects bad saved values. Rules that need context live in `validateSettings(raw, context)` in `lib/settings-validation.ts`, which forms and API routes call.
- **Field-level result:** `{ ok, settings | errors, warnings }`. Each issue is `{ field, message }`, with `field` a dot path such as `tierBoundaries.tier2` or `interval.dates.1`. Every invalid field is reported at once. Unknown keys are reported by name.
- **Due date before deadline:** a warning on `paymentTerms`, never an error. It's checked when the due date is known: a specific date, or Net terms plus `issuedOn`. Inherited terms come from `context.parent`. Deposits will often warn, which is expected.
- **Late fee needs a contract clause:** on project and milestone layers (`contractHasLateFee: false`), setting a late fee is an error. This follows the spec's "only if the contract has one". Account and client defaults may set one. Whether an inherited late fee is used for a project without a clause is gated when drafting (M5), alongside the Tier 3 legal gating.
- **No extra rules:** grace longer than Tier 1 isn't an error; the schedule then starts at the tier for that day. The spec doesn't ask for that check.

## M2 Clients, projects and milestones

### 2026-11-03: Clients CRUD
- **Dev server on 127.0.0.1:** `next dev --hostname 127.0.0.1` (asked for by the user). In dev every request acts as one local user, so the dashboard must not be reachable from the network.
- **Who is signed in:** real sign-in isn't in the feature list, so `lib/auth.ts` returns the seeded demo freelancer (or `DEV_USER_ID`) in development and throws in production. Real Supabase Auth is in `docs/NEEDS_YOU.md`.
- **Database access:** `pg` (added to `apps/web`; no install scripts, already a root dev dependency) instead of the Supabase JS client, because the local stack is plain Postgres. `runAsUser` opens one transaction with `SET LOCAL ROLE authenticated` and `request.jwt.claims.sub`, so the same RLS policies apply as on Supabase. A failed transaction discards its pooled connection. `lib/supabase.ts` stays an empty stub for now.
- **Owner on insert:** `user_id` comes from `auth.uid()` in SQL, never from the request. Unknown body fields (such as `user_id`) are rejected.
- **Route handlers:** `lib/client-handlers.ts` takes the "run as user" function as a parameter. The route files pass the real one; integration tests pass PGlite with real RLS. Another user's client, or an id that isn't a UUID, answers 404.
- **JSON only:** POST and PATCH require `Content-Type: application/json` (415 otherwise). A cross-site page can then only call these with a CORS preflight, which the server never approves. This keeps forms from other sites out once real cookie sign-in arrives.
- **Country and time zone:** `countries-and-timezones` (MIT, no dependencies, no install scripts; `npm audit` clean) for the ISO country list and each country's zones. That's IANA data we shouldn't hand-copy. A country's zone list is its own zones only; where tzdata merged a zone into a neighbour's, the country's own alias is used (NL → `Europe/Amsterdam`). Countries with several zones default to the capital's or most populous zone (US → `America/New_York`, AU → `Australia/Sydney`), and a test fails if a multi-zone country has no chosen default. Antarctica and Heard Island are left out. The data stays on the server; pages pass the list to the form as props.
- **Time zone follows the country:** a missing time zone is the country's default. When the country changes, a zone that isn't one of the new country's moves to its default, in the form and in PATCH. Any valid IANA zone can be picked under "Other time zones".
- **Open balance:** per currency, the amount minus the amount paid on invoices that are sent, partially paid or disputed. Invoices reach a client through milestone → project, or through a retainer.
- **Last activity:** the latest of the client's own update, its invoices' updates and its messages. Shown as "today", "yesterday" or "N days ago", which needs no time zone (`users` has no time zone column yet; see M6).
- **One formatter each:** `lib/format.ts` has `formatMoney` ("USD 1,500.00", built from integer minor units with no float maths, using the currency's own decimals) and `formatDaysAgo`.
- **Event log:** `lib/log.ts` writes one JSON line per event to stderr, with ids and error class names only, never messages or bodies.
- **`db:seed` is local-only too:** it writes `auth.users`, so it gets the same host guard as `db:dev-auth`. For now the seed holds only the demo freelancer (`example.test` email); the demo project comes in M10.
- **Not-found under streaming:** an unknown client id renders the 404 page with `noindex`, but the HTTP status is 200, because `loading.tsx` starts the stream first. That's standard Next.js behaviour; the API answers a real 404.

### 2026-11-03: Projects and ScheduleForm
- **`projects.deadline`** (migration `003_project_deadline.sql`): a single-invoice project needs its own delivery deadline. The column is nullable so older rows stay valid; the API requires it.
- **Currencies:** the 24 currencies on PayPal's supported-currencies page (updated 10 Jul 2026). BRL, CNY and MYR are labelled "in-country PayPal accounts only", as PayPal notes. That page is a reporting reference, so M3 must confirm per-API acceptance in the sandbox.
- **Minor units follow PayPal's decimals:** HUF, JPY and TWD have no decimals in PayPal (ISO gives HUF and TWD two), so 1,500 forint is stored as `1500`. `minorDigits()` in `lib/currencies.ts` is the single source; `formatMoney` and the amount input use it. M3's PayPal conversion must use it too.
- **Amount input:** typed amounts ("3,000.50") are parsed to minor units with string maths, never floats. The API takes `totalCents` as an integer.
- **Steps on one page:** step 1 (details) and step 2 (schedule) are numbered sections of one form rather than a wizard. Step 3 (milestones) goes on the project page, because milestones need the saved project (next feature).
- **ScheduleForm stores only changes:** each group shows the inherited value (account, then client). A group is saved as an override only when it differs, and "Use the default" removes it. Validation runs live with the same `validateSettings` the server uses, and the preview runs the real schedule engine (`describeSchedule` in `lib/schedule-preview.ts`, assuming the invoice goes out on the deadline).
- **Pause and snooze aren't in the new-project form:** they're actions on a running project, and the API already accepts them. Controls come with the Outbox and project actions.
- **Late fee needs the clause, live:** the late-fee control appears only once the contract's late-fee clause is filled in, matching the server rule.
- **A project can't move to another client:** `clientId` isn't accepted on PATCH. A PATCH is checked against the saved values, so clearing the late-fee clause while a late fee is set is rejected.
- **No projects index page:** `docs/DESIGN.md` lists none. Projects appear on their client's page; the sidebar's Projects link opens New project.
