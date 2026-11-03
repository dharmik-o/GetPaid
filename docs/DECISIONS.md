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

### 2026-11-03: Milestones

- **Rounding (the user's rule, from M0):** percentages convert to minor units rounded half up, and the last milestone absorbs the remainder, so the plan always adds up to the project total exactly. BigInt is used where total × basis points could pass 2^53. **Mixed plans** (some amounts, some percentages) are allowed: the remainder goes to the last _percentage_ milestone, so a typed amount is never changed.
- **Totals check:** amounts plus percentages of the total must equal the project total exactly, compared as integers (amounts × 10000 + total × bp = total × 10000). All-percentage plans must add up to 100%. An empty plan is valid: the project is billed as one invoice.
- **Deadline order:** a milestone due before the one above it gets a warning, not an error. Rows still being typed (a blank or partial date) are skipped; a blank date used to crash the editor, which the regression test covers.
- **Whole plan per save:** `PUT /api/projects/[id]/milestones` replaces the plan, so totals always see every milestone. Positions follow list order (the unique-position constraint is checked at commit, which allows reordering). Ids from another project are rejected.
- **Invoiced milestones are locked:** from Invoiced on, or whenever the milestone has an invoice row that isn't cancelled, its amount or percentage can't change and it can't be removed. Deleting it would cascade-delete the invoice. Name and deadline can still change.
- **Lifecycle (`lib/milestone-status.ts`):** exactly the spec's statuses. A person can only move work forward: Planned → In progress → Delivered → Accepted, and Delivered → In progress when the client asks for changes. Invoiced, Paid, Partially paid, Overdue and Disputed are set only by the invoice flow and PayPal webhooks (M3), never by hand, which keeps money status out of reach of people and email text.
- **Not in the editor yet:** per-milestone deliverable, acceptance window and schedule overrides (including payment terms) are accepted and validated by the API (overrides against the project's schedule and late-fee clause) but have no inputs yet. The editor covers the fields `docs/DESIGN.md` lists for `MilestoneEditor`: name, amount or %, deadline, mode. The hold-length warning is part of M9.

## M3 PayPal invoices and webhooks

### 2026-11-03: Invoices

- **Sandbox only, fixed in code:** `lib/paypal.ts` always calls `https://api-m.sandbox.paypal.com`. No env var or input can point it elsewhere. Credentials are `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (`PAYPAL_WEBHOOK_ID` is for the webhook item). They're checked the first time PayPal is used and by `npm run env:check`, not at startup, so the rest of the dashboard runs without them.
- **No duplicates (spec wording fixed):** the real sandbox showed that **Invoicing v2 ignores `PayPal-Request-Id`**: the same id twice created two invoices. The header is still sent on every create (project rule), but the guard is the invoice number. Each invoice row gets a unique `FPR-` number from a Postgres sequence (migrations 004 and 005) before PayPal is called. PayPal refuses a second invoice with the same number (`DUPLICATE_INVOICE_NUMBER`), and the client then searches for that number (exact match) and reuses the invoice. Verified in the sandbox. The spec's PayPal table now says this.
- **Order of steps:** (1) a short transaction checks the milestone and commits the draft row (request id, number, amount, due date); (2) PayPal create, then the PayPal id is saved; (3) PayPal send; (4) a transaction marks it sent with the pay link and sets the milestone to Invoiced. PayPal is never called inside a transaction. A retry after a failure at any step resumes the same row and the same PayPal invoice; tests cover a failed send and a lost create answer. Two racing clicks meet the one-open-invoice-per-milestone index and both get the same row.
- **PayPal emails nobody:** send and cancel use `send_to_recipient: false` and `send_to_invoicer: false`. "Send" only makes the invoice payable and gives the pay link. The client hears about it only in a reminder the freelancer approves (security rule 5).
- **Partial payments on every invoice** (spec: "with partial payments turned on"), so the client can pay in parts (demo step 6). **Deposits** also set `minimum_amount_due`. The freelancer types it when creating the deposit invoice: required, more than 0 and no more than the amount. It's refused on other modes, and stored in `invoices.minimum_due_cents`. The spec gives no default, so none is guessed.
- **When a milestone can be invoiced:** pay on invoice once Delivered or Accepted ("created when the milestone is delivered"). Deposit from Planned through Accepted ("sent at kickoff"). Milestone holds never get an invoice (authorizations, M9). Asking again returns the existing invoice (200); a new send answers 201.
- **Due date:** issued "today" in the client's time zone, due date from the merged terms (account, client, project, milestone), via `invoiceDates()` in `lib/schedule.ts`. "Due on receipt" uses PayPal's `DUE_ON_RECEIPT` term rather than a date, which could be "yesterday" in the PayPal account's zone. A fixed date that has already passed is refused, with a message to change the terms.
- **Cancel:** an unpaid invoice only. A PayPal draft is deleted (PayPal can't cancel drafts) and a sent one is cancelled. Anything with money on it is refused (409) and nothing changes. The milestone goes back to its status before invoicing (`invoices.milestone_status_before`), and reminders still waiting for approval are skipped. Repeating it is safe. The milestone can then be invoiced again with a new number.
- **Errors:** PayPal's refusals are shown as its issue code, the field, PayPal's short reason and the debug id (502). Logs carry only status, issue and debug id, never bodies. Without credentials the API answers 503 with what to add. Network failures before any answer are retried once (this machine sees intermittent DNS `EAI_AGAIN`).
- **One project, one invoice:** the invoices table needs a milestone (or retainer), so a single-invoice project is billed through one milestone at 100%; the Invoices card says so when there's no plan. No hidden auto-created milestone.
- **msw 3** (`msw`, dev only) mocks PayPal in tests, as CLAUDE.md asks. No install scripts; `npm audit` shows no new advisories (the same 13 moderate ESLint/minimatch ones). msw 3 calls the strict option `onUnhandledFrame: "error"`, so any unmocked request fails the test instead of reaching the network. `tests/mocks/paypal.ts` is an in-memory sandbox that behaves like the real one (ignores the request id, refuses repeated numbers).
- **Sandbox tests:** `npm run test:paypal:sandbox` runs `tests/*.sandbox.test.ts` against the real sandbox (never part of `npm test`). Test invoices use a `TEST-` number prefix and are cleaned up.
- **Invoice numbers keep every digit (bug fix):** 004's `lpad(n, 6)` cut numbers past 999,999, so they would repeat. 005 pads to at least six digits instead (`FPR-000042`, `FPR-1000000`). A sandbox run that started the sequence high caught it; a test in `tests/db/schema.test.ts` reproduces it.
- **Test timeout 15 s:** with 20 workers each starting an in-memory Postgres (PGlite), two older tests that start an extra database inside the test body sometimes passed 5 s. Assertions are unchanged.

### 2026-11-03: Webhook handler

- **The app verifies and applies; n8n relays.** `POST /api/webhooks/paypal` holds the logic, in tested TypeScript. `n8n/workflows/06_paypal_webhook.json` is three nodes: Webhook (raw body) → HTTP Request to the app with the exact bytes and the five `PayPal-*` headers → respond with the app's status. It checks nothing itself and writes nothing; the app verifies before any write. The relay's app URL is fixed (`http://host.docker.internal:3000`, local dev), because reading `$env` would mean letting every n8n expression see n8n's own secrets. Hand-written because it's three nodes; it imports into n8n 2.45.7 cleanly.
- **Verification:** `POST /v1/notifications/verify-webhook-signature` with `PAYPAL_WEBHOOK_ID`, the five headers and the event **spliced in byte for byte**. Re-serialising could change what PayPal checks. Splicing is safe because the body must first parse as one JSON object. Missing headers or a non-object body: 400, without calling PayPal. FAILURE: 401, logged, nothing changes. Verification service down or webhook id missing: 503, so PayPal retries later. Body capped at 1 MB. Confirmed in the real sandbox that a forged delivery gets FAILURE (not an error).
- **PayPal's copy wins:** for invoice events (`INVOICING.INVOICE.PAID`/`UPDATED`/`REFUNDED`/`CANCELLED`, and `PAYMENT.CAPTURE.REFUNDED` matched by our invoice number), the handler reads the invoice from PayPal and uses its status and amounts, never the event body. A late or repeated event can't move anything backwards; a test sends a signed "PAID" for an invoice PayPal still shows unpaid, and nothing changes.
- **Statuses:** PAID/MARKED_AS_PAID → paid; PARTIALLY_PAID → partially paid; any refund → refunded, with `amount_paid` = paid − refunded; CANCELLED → cancelled (milestone back to its pre-invoice status). The milestone follows paid, partially paid and disputed. On a refund the milestone is left alone (there's no milestone "refunded" status) and the invoice shows Refunded. A dispute stays Disputed through payment updates, until a refund.
- **Disputes:** `CUSTOMER.DISPUTE.CREATED` is matched by `disputed_transactions[].invoice_number` (our `FPR-` number). Invoice and milestone become Disputed and reminders stop. The evidence timeline is M10.
- **Reminders stop on any payment change:** paid, refunded, cancelled and disputed stop every reminder not yet sent (waiting, or approved but unsent). A partial payment does too, because those drafts quote the old balance; the scheduler (M5+) drafts new ones for the remaining amount. Sent reminders stay in the log.
- **Each event once:** the PayPal event id goes into the audit log in the same transaction as the changes, with a unique index (migration 006), so a repeat (even a simultaneous one) does nothing (`outcome: duplicate`).
- **Service role only here:** `lib/service-db.ts` (`SET LOCAL ROLE service_role`) is imported only by the webhook route. The handler has no user session; it finds the invoice by PayPal id or invoice number and writes events with that invoice's `user_id`.
- **Not handled yet:** `PAYMENT.CAPTURE.COMPLETED` (milestone holds, M9) and subscription events (retainers, M8) are verified and acknowledged without changes.

### 2026-11-03: Installments replace partial payments; invoice templates (approved change)

- **Folded in:** `docs/CHANGE-installments-and-templates.md` (approved by the user today) is now part of `docs/MVP-spec.md`: overview, payment modes, a new Installments part under Milestones, reply handling, the PayPal table, a new Invoice templates section, the data model, scope and demo steps 2, 5 and 6. `docs/FEATURES.md`: the M3 Invoices item is reworked, the M7 reply listener gets the installments branch, and M5 ends with a new Invoice templates item. The partial-payments item in `docs/NEEDS_YOU.md` is done.
- **A deposit of the whole milestone is one plain invoice (detail fix):** the change's rules say a deposit is less than the milestone amount and a plan has 2 to 12 installments, but its demo step 2 sets up the $900 Design milestone as "installment 1 of 1". Choice: a deposit equal to the milestone amount is one invoice at kickoff with no plan and no "1 of 1" line. Why: it keeps both rules true, the demo outcome is the same (pay it, milestone Paid), and the client doesn't see "Installment 1 of 1".
- **Deposit due dates:** "due at kickoff" and "due when the milestone is delivered" say when each installment is invoiced. Each is then due per the merged payment terms from that day, as every other invoice is.
- **Where a plan's amounts and dates live:** `installment_plans.items` (a JSON array, one entry per installment), because a setup plan and a deposit's second installment exist before their invoices do. The change lists the plan's other columns; this one is added.
- **Cancelling a plan (detail added to the spec):** cancelled as a whole, and only while nothing on it is paid. Cancelling one installment would leave the plan not adding up; once something is paid, the M7 split of the unpaid remainder is the way to change it.
- **Client-request splits are M7:** the change's "Where it goes" puts installment requests from replies in the reply listener. The split of the unpaid remainder (cancel the open unpaid invoices, then create the installments, in one approved step) is built there, so M3 has no unused code for it.
- **Thirteen tables:** `installment_plans` (M3) and `invoice_templates` (M5) join the eleven.

### 2026-11-03: Invoices reworked for installments

- **No PayPal partial payments anywhere:** `InvoiceDraft` has no partial-payment field and the create body has only `allow_tip: false` in `configuration`. The PayPal mock now records every request body, and the invoice API tests check after each test that no request contains `partial_payment`, `allow_partial_payment` or `minimum_amount_due`. Migration 007 drops `invoices.minimum_due_cents`.
- **Migration 007:** `installment_plans` (owner RLS, one active plan per milestone, `items` length equals `count`, 2 to 12) plus `total_cents` and `currency`, so the plan's money has a currency like every other money column. `invoices` gets `installment_number`, `installment_count` and `installment_plan_id` (all set or all null, number ≤ count). The one-open-invoice index is now per (milestone, installment number), with a plain invoice as number 0.
- **API:** `POST /api/milestones/[id]/invoice` takes `depositCents` (deposits) or `installment` (a deposit plan's next one) and answers `{ invoices }`. `PUT` / `DELETE /api/milestones/[id]/installments` save or remove a setup plan until its first invoice exists. `POST /api/invoices/[id]/cancel` also answers `{ invoices }`; for an installment it cancels the whole plan.
- **When each is invoiced:** a setup plan's installments all at once, once the milestone is Delivered or Accepted. A deposit's installment 1 from Planned on; installment 2 when the freelancer clicks "Work delivered: invoice the rest" (any time after installment 1, since an invoiced milestone can't be marked Delivered by hand, as before). Asking again returns the invoices already there, so a retry or double click never duplicates.
- **Due dates:** a setup installment is due on its own date; a deposit's installments per the merged terms from the day each is invoiced. A due date of today (or a resumed invoice whose date has passed) goes to PayPal as due on receipt, as before. Dates must not be in the past when the plan is saved, and again when it's invoiced.
- **Totals are rechecked when invoicing:** the milestone amount can still change before its first invoice, so a setup plan that no longer adds up to the milestone is refused with a message to change it.
- **Invoice text:** the item description is "Installment 2 of 3 for Website redesign: Build" and `detail.note` adds the totals line and the other installments' due dates (with "(paid)", or "due when the work is delivered" for a deposit's rest). "Paid so far" is what the milestone's other open invoices had received when this one was created. All figures are integer cents formatted by `formatMoney`; dates by the new `formatFullDay` ("3 Nov 2026").
- **Even split:** each share is total ÷ count rounded half up, and the last absorbs the remainder (1,001 ÷ 2 = 501 + 500), matching milestone percentages.
- **Statuses (webhook):** for an installment, the milestone becomes Paid once every installment of the plan is invoiced and paid (the plan is then `completed`), else Partially paid; a cancelled installment leaves the milestone alone while it has other open invoices. Plain invoices behave as before.
- **Cancelling:** only while every installment of the plan is unpaid; PayPal drafts are deleted and sent ones cancelled, then the plan is `cancelled` and the milestone goes back to its status before the first invoice.
- **Component test:** `tests/invoice-panel.test.ts` renders the Invoices card with `react-dom/server` (already installed with the web workspace; no new dependency). The root `tsconfig.json` gets `jsx` and the DOM lib so the root typecheck can read components. Your running dev server (PID 948) still has the compile-worker crash from M3, and Next won't start a second dev server beside it, so the card hasn't been seen in a browser yet.

## M4 Bring your own AI

### 2026-11-03: AI settings screen

- **Shape:** one **main model** and, only when the main model is local, an optional **cloud fallback**. That's the spec's order (local, then cloud only if the user allows it, then a template), and the user allows it by adding one. Optional per-task model names for sorting replies and for Tier 3 use the main model's provider and key. Stored in `ai_providers` as one row per task (sort, draft, tier3) and order (1 main, 2 fallback).
- **Migration 008:** `ai_providers.is_local`, and a check that `base_url` is http(s). Presets decide local or cloud; Custom URL has a "runs on my machine or network" box.
- **Presets:** the spec's eight. Each base URL is the provider's OpenAI-compatible endpoint (Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama `/v1`, LM Studio `/v1`). Only Claude suggests a model (`claude-sonnet-5-5`); the others ask for one rather than guess a name. The local LiteLLM gateway is reached through Custom URL.
- **Keys:** encrypted with `lib/crypto.ts`, bound to `ai_providers.api_key_enc:<user id>:<order>`. The browser only ever gets `hasKey`. A blank key field keeps the saved key, but only for the same server (scheme, host and port): a saved key is never sent to an address the user just typed. An empty string removes it. Presets that need a key refuse to save without one.
- **Base URL limits (the server calls these addresses):** http(s) only; no user name or password in the URL; no `?` or `#` parts; never a cloud metadata address (169.254.0.0/16, `metadata.google.internal`, IPv6 equivalents); and https for anything that isn't local, so a key never travels unencrypted. The same check runs again before every call (router).
- **Model names:** letters, digits and `. : / @ + -`, up to 200 characters. That covers `llama3.2:1b` and `provider/model`, and keeps anything odd out of requests and logs.
- **`secretBox()` exported from `lib/crypto.ts`,** so handlers take a `SecretBox` and tests pass a throwaway key.

### 2026-11-03: AI router

- **The app routes; n8n relays (same pattern as the PayPal webhook).** `lib/ai-router.ts` holds the logic in tested TypeScript, and `07_ai_router` is two nodes: Execute Workflow Trigger → HTTP Request to `POST /api/internal/ai/route`. Keys are encrypted with the app's `ENCRYPTION_KEY` and bound to the row, so decrypting them in n8n would mean giving n8n that key and rewriting the crypto in a Code node. Spec wording updated. Imported into n8n 2.45.7, inactive.
- **Direct OpenAI-compatible calls, LiteLLM as the gateway for the rest (spec wording updated):** Claude, OpenAI, Gemini, Groq and OpenRouter all accept the OpenAI chat format at their own endpoints, as do Ollama, LM Studio and vLLM. Calling them directly keeps each user's key between the app and that provider; routing per-user keys through a shared gateway would pass every key through one more service. LiteLLM stays in the stack for providers without such an endpoint (Bedrock and others) and for the offline `mock` model, reached with Custom URL. The fallback between models is the router's own (below), not LiteLLM's.
- **Fallback order:** local models first, then the cloud fallback (only if the user added one), then the caller's fixed template. A model that can't be reached (network error, timeout, any HTTP error) passes to the next. An answer that doesn't match the schema is retried once on the same model with a short reminder; a second bad answer goes **straight to the template** (the done-when: "invalid JSON triggers one retry and then the template"), not to another model. With no template (for example a redraft from the freelancer's own words), the result is "unavailable" or "invalid", and the caller waits ("Otherwise the reminder waits until the model is back").
- **One call shape:** `POST {baseUrl}/chat/completions` with `model`, `messages` and `temperature: 0`. No `response_format`, because not every compatible server accepts it; prompts ask for JSON, and the router takes the JSON object from the answer (code fences allowed) and checks it with zod. Timeout 60 s per call (local models on a laptop are slow). Redirects are refused, so a key can't be forwarded elsewhere. The base URL is checked again before every call.
- **Schemas:** `lib/ai-schemas.ts` (zod) is the source for `classification` (the six labels from the reply table, the promised or return date, a one-line summary) and `draft` (subject and body). `prompts/schemas/*.json` are generated from it (`npm run ai:schemas`, new) with `z.toJSONSchema`, and a test fails if they drift. So zod checks are checks against the JSON files, with no JSON Schema library added. M5 and M7 extend these schemas as their prompts need.
- **Internal endpoint:** n8n proves itself with a Bearer `INTERNAL_API_TOKEN` (new env name, at least 32 characters, compared in constant time; 503 until it's set). The endpoint then reads the user's models **as that user** (RLS), not as the service role. It returns the checked output and a summary of attempts (provider, model, outcome, "HTTP 401" or "timed out", time). Never message text or keys, in the answer or the logs.
- **Hook block:** a by-hand run against LiteLLM that loaded the env file was refused by the protect-files hook; logged in `docs/NEEDS_YOU.md`, not worked around. The same run without a key showed the real-HTTP 401 → template path.

### 2026-11-03: Test connection

- **What runs:** the spec's 4 sample tasks: sort a reply that promises a date, sort one that asks to pay in parts, draft a Tier 1 email, draft a Tier 2 email. Made-up data only (fake names and a fake sandbox pay link), so nothing real goes to a cloud model. Sorting uses the per-task sort model, drafting the main model.
- **No template here:** the tasks go through the real router with no template, so a model that answers badly twice shows as **Fail** ("would use the fixed template") instead of quietly passing. The cloud fallback still steps in when the local model is down, and the result says so.
- **Pass means:** the answer matches the schema, and the sort label is the expected one, or the draft carries the pay link exactly as given.
- **Results:** pass or fail, the model that answered (local or cloud) and the time, or what failed with a hint ("HTTP 401: check the API key", "couldn't connect: check the base URL, and that the model is running"). Never the key, the prompts or the answers.
- **Prompts:** these are connection checks, written in `lib/ai-test-tasks.ts` next to the checks that grade them. The production prompts in `prompts/*.md` come with M5 (drafting) and M7 (sorting). Client text is quoted in `<reply>` tags and called data, not instructions, as the prompt rules ask.
- **Not ticked:** the done-when includes runs with Claude and Ollama by hand, which need your key and a model on your PC (`docs/NEEDS_YOU.md`).

## M5 Drafting

### 2026-11-03: Prompts

- **Source and copy:** `prompts/*.md` hold the prompt text (title line, then the system prompt). The app can't count on reading files outside `apps/web` at run time, so `npm run ai:prompts` (new) writes them into `lib/prompt-text.ts`, and `tests/prompts.test.ts` fails if the two drift (same pattern as the schemas).
- **One output schema:** courtesy, Tier 1, 2, 3 and the maintenance heads-up all answer `draft` (`subject`, `body`); no schema change.
- **Facts, not free text:** each prompt gets the facts as JSON between `<facts>` tags, every value already formatted from the database (money by `formatMoney`, dates as "31 Oct 2026"). `<` in a fact is JSON-escaped so a client name can't close the tag. Only Tier 3 ever sees a `citation`.
- **Checks beyond the shape (`lib/draft-checks.ts`):** a reminder must carry the pay link exactly and no other link; a maintenance heads-up has no link; any money amount (with a currency code or symbol) must appear in the facts (so "$1,500" for "USD 1,500.00" is fine, an invented fee is not); the subject has no line break. They run inside the schema the router checks (`checkedDraftSchema`), so a failing draft is retried once and then replaced by the fixed template, like invalid JSON.
- **Fixed templates (`lib/draft-templates.ts`):** one per kind, built only from the facts, and passing the same checks. With a template always available, a reminder never waits on the model.
- **Maintenance heads-up:** prompt, template and checks now; storing and approving it comes with M8, because `reminders` are tied to invoices.

### 2026-11-03: Drafter

- **The app drafts; n8n relays (as with the AI router).** `02_drafter` is two nodes: Execute Workflow Trigger (`userId`, `reminderId`) → HTTP Request to `POST /api/internal/drafts` (Bearer `INTERNAL_API_TOKEN`, same credential as `07_ai_router`). The app calls `lib/ai-router.ts` in-process rather than going back out through n8n: it's the same router code `07_ai_router` relays to, and in-process the content checks (pay link, amounts, legal gating) run inside the router's retry-once-then-template rule. Calling 07 from 02 would put the checks after the router, where a bad draft could only fall to the template with no retry. Spec wording updated. Imported into n8n, inactive.
- **Facts from the database only:** client, freelancer, project, milestone and deliverable, invoice number, amount left to pay (amount minus paid, by `formatMoney`), due date, days overdue (new `daysOverdue` in `lib/schedule.ts`, in the client's calendar), merged payment terms (new `formatPaymentTerms`), contract terms (first 2,000 characters), installment "2 of 3", and the invoice's own PayPal link. The n8n input is only the two ids.
- **When it refuses:** not found for this user (RLS) 404; already approved or skipped 409; invoice not sent, paid, cancelled or with nothing left 409. Retainer invoices answer "unsupported" until M8.
- **Idempotent:** a reminder with a draft is left alone (200 "exists", no model call). The save is `UPDATE … WHERE draft IS NULL AND approval_status = 'waiting'`, so a race between two runs keeps the first. The model call runs outside any transaction.
- **Stored draft (`reminders.draft`, `lib/stored-draft.ts`):** subject, body, tier, `via` (model or template), model and local/cloud, the citation kind and law id (Tier 3), `notLegalAdvice` (true on every Tier 3), drafted-at. An event `reminder.drafted` records tier, via, model and citation kind, never the text.
- **Models per task:** Tier 3 uses the `tier3` task's model; every other tier the `draft` task's.
- **`lib/internal-auth.ts`:** the Bearer check moved out of the AI route handler so both n8n-facing endpoints share it.
