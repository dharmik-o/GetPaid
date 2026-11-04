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

### 2026-11-03: Legal gating
- **Order:** the contract's own late-fee clause first (it's what the client agreed to), quoted as written: `Our contract's late-payment clause says: "…"`. Otherwise the first law in `legal/statutes.json` for the client's country. Otherwise no citation: a plain "Final notice:" with nothing legal in it.
- **Table shape (`lib/legal.ts`, zod):** `id`, `name`, `countries` (ISO alpha-2), `citation` (the one sentence a notice may include, written and checked by a person), `sourceUrl` (https), `checkedOn`, optional `condition`. A law with a condition (NYC's law is city-only, India's MSMED Act needs a registered MSME) is **never cited automatically**, because the app can't check the condition. Generated into `lib/statute-table.ts` by `npm run ai:prompts`; a test catches drift.
- **Check on every reminder draft:** after taking out the given citation and the quoted contract terms, the text may not name a law in the table or use legal or fee words (law, legal, statute, Act, directive, regulation, court, lawyer, solicitor, collection agency, late fee, interest, penalty and others). Tiers 1 and 2 and the courtesy note may never cite. A failing draft is retried once, then the template is used. This is strict on purpose: a false alarm only means the fixed template.
- **The table is still empty.** The rules say to ask before adding an entry (`docs/NEEDS_YOU.md`), so until then a Tier 3 notice cites only a contract clause, or nothing. Tests use a made-up table (`tests/fixtures/statutes.ts`).
- **"Not legal advice" note:** every Tier 3 draft is stored with `notLegalAdvice: true`. The Outbox and Telegram cards (M6) show the note to the freelancer. It isn't put in the client's email.

### 2026-11-03: Invoice templates
- **New dependencies (no install scripts; `npm audit` shows only the 13 moderate ESLint/minimatch findings that were already there):** `mustache` 4.2.0 (logic-less tags with HTML escaping, as the spec names), `sanitize-html` 2.18.1 (allow-list HTML sanitiser; writing one by hand is how sanitisers get bypassed), `postcss` 8.5 (already in the tree through Next and sanitize-html; now a direct dependency for the CSS allow-list), `playwright-core` 1.64.1 (the same version as `@playwright/test`, so it drives the Chromium you installed; Next already keeps it out of the server bundle), plus `@types/mustache` and `@types/sanitize-html`.
- **Migration 009:** `invoice_templates` (built-ins have `user_id` NULL and kind `builtin`; a check ties the two; HTML plus CSS ≤ 100 KB). RLS: a signed-in user reads the built-ins and their own; only their own custom ones can be added, changed or deleted. `users` gets `default_template_id`, `business_name`, `address`, `logo_data_url` (embedded PNG, JPEG, GIF or WebP only, ≤ 300,000 characters); `clients` gets `default_template_id`, `company`, `address`; `invoices` gets `template_id`, `pdf_path`, `invoice_text`. The three built-ins (Classic, Modern, Minimal) are seeded in the migration with fixed ids. Applied locally.
- **Default per account, not `is_default` (spec detail fixed):** a built-in row is shared, so it can't hold one user's "default" flag. The account default is `users.default_template_id` (NULL = Classic) and the client override is `clients.default_template_id`. An invoice uses: the pick on Create invoice, else the client's, else the account's, else Classic. A template the user can't see (another user's, or deleted) is skipped.
- **Shared rows and the RLS suite:** the generic one-row-per-owner suite can't cover a table with shared rows, so `invoice_templates` is a "shared table" in `tests/db/fixtures.ts`, with its own RLS tests (`tests/db/invoice-templates-rls.test.ts`).
- **Tags:** exactly the spec's table. `{{expense_1}}` … `{{expense_10}}` are "name: amount" of the first ten line items (empty if there's no such row). `{{#installment.schedule}}` rows have `{{number}}`, `{{amount}}`, `{{due_date}}`, `{{status}}` (paid, due, this invoice). Any known tag can also open a section (`{{#client.company}}…{{/client.company}}`, or `{{^…}}`) to show something only when it has a value; the built-ins use this for the logo, the installment block and the late-fee clause. Unknown tags, `{{{…}}}`, `{{& …}}`, partials and delimiter changes are errors with their line number.
- **Sanitiser (on save, and on every preview):** allow-listed HTML elements and attributes; `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, forms and their content are removed; `on*` handlers and `javascript:` values are removed. `href` may be https, mailto, `#…` or exactly `{{invoice.pay_link}}`; `src` only an embedded image or exactly `{{freelancer.logo}}`. CSS goes through postcss: known properties only, `@media` and `@page` only, no escapes or `expression()`, `url()` only for embedded images. Anything that would load from the network (a remote image, stylesheet, font or `url()`, or `@import`) **refuses the save** rather than being silently dropped, so you see why. Tags or a `<` in the CSS are refused too (the CSS sits inside a `<style>` element).
- **Rendering:** Mustache fills the sanitised HTML with escaping on; the document carries a Content-Security-Policy (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`). The editor preview is an iframe with `sandbox=""` (no scripts, its own origin). The PDF comes from headless Chromium with JavaScript off, the context offline, and every request aborted. A test serves a hostile page (remote image, stylesheet, `@import`, script fetch, iframe, background) to a local server and sees zero requests; a one-off control run without the locks saw them.
- **AI text:** a new `invoiceText` schema (`prompts/schemas/invoice-text.schema.json`) and `prompts/invoice_text.md`. Text is rejected if it has any digit, currency symbol or code, money or number word, month, weekday, or relative date ("today", "next week"). Database values the text may quote (client, project and milestone names, so "Website v2" is fine) are taken out first. A rejected answer is retried once, then the fixed text is used. The same check applies to text the freelancer edits, because every amount and date on the invoice must come from the records. With no text given, the fixed text is stored.
- **PDF storage:** files under `INVOICE_PDF_DIR` (optional env name; default `.data/invoice-pdfs` beside the app, git-ignored). The database keeps only `<user id>/<invoice id>.pdf`, and nothing else is ever read. The PDF is made right after an invoice is sent. A failure is logged and never undoes the invoice; the download (`GET /api/invoices/[id]/pdf`) makes it again if it's missing.
- **Attached to reminder emails:** `lib/reminder-email.ts` builds the reminder email (plain text, on the invoice thread) with the invoice PDF as a **required** argument, so a reminder can't be built without it. M7's sender passes it to Gmail. Header values can't carry line breaks.
- **Not attached to the PayPal invoice:** the Invoicing v2 reference documents `detail.attachments` as references to PayPal file ids, but no endpoint to upload a file and get one (checked 3 Nov 2026). Spec wording updated.
- **Screens:** Settings > Invoice templates (built-ins and yours; Preview/Edit, Duplicate, Set as default; your business name, address and logo); the editor at `/settings/templates/[id]` (and `/new`), with HTML and CSS side by side, a live preview, a click-to-insert tag list and the sanitiser's notes inline; built-ins open read-only with "Duplicate it to edit". On the project's Invoices card: an "Invoice document (PDF)" section per milestone (template pick, "Write the text with AI", editable text) and an "Invoice PDF" link on every sent invoice. On the client page: company, address and default template. The settings endpoint saves only the fields it's sent, so setting the default and saving the details can't overwrite each other.
## M6 Approvals

### Outbox page (4 Nov 2026)

- **Freelancer's time zone (schema gap found in M1):** the spec shows send times in both zones, but `users` had no zone. Migration 010 adds `users.time_zone` (`NOT NULL DEFAULT 'UTC'`), set in Settings. The default is safe because the card always names the zone, so it never implies a local time that isn't one. It's for display only: send windows still use `clients.time_zone`. Spec data model updated.
- **Which send time a card shows:** when the reminder can really go out (`effectiveSendAt` in `lib/schedule.ts`: never in the past, always inside the client's window), not the stored `scheduled_at`, which can be stale. "Nothing hidden" means showing the true time. M7's sender should use the same function.
- **The four tabs:** Waiting = waiting with a draft; Scheduled = approved, not sent; Sent = has `sent_at`; Skipped = skipped. A reminder with no draft yet isn't listed and answers 404.
- **Approving only records the decision:** it sets `approved`/`outbox` and nothing else. Sending is M7's job, so an approved draft waits in Scheduled until then.
- **Approve re-checks at the last moment:** the stored draft must pass `storedDraftSchema`, the invoice must still be payable, and the body must still hold the invoice's pay link. A draft that fails the schema can only be skipped (security rule 5).
- **Races:** every UPDATE repeats the state it checked, so a double approve changes nothing the second time and answers 409.
- **Edits pass the same checks as the AI (`draftProblems`):** pay link kept, no other link, no amount that isn't in the facts, no legal or fee wording beyond what the tier was given. A person's edit could otherwise add a wrong amount or an invented law (security rule 6, "never guess about money or legal text"). The cost: a freelancer can't add another link, such as a portfolio. An edit is allowed only while waiting, because changing approved wording would send something that wasn't approved.
- **Skip also stops an approved draft that hasn't gone out** (shown as "Stop this send"). Spec detail: it lists the actions but not this state, and a freelancer who changes their mind needs a way out before the send.
- **Reschedule:** the time is entered in the client's zone, as the send window is theirs. A time outside the window moves to the next opening rather than being refused, and the card then shows the real time. A past time is refused. Approval is unchanged. Allowed while waiting or scheduled.
- **Sidebar badge:** the sidebar fetches `GET /api/outbox/summary` on navigation and every 30 seconds, instead of the root layout reading the database: a layout error can't be caught by a page's `error.tsx`, and a layout doesn't re-run on client navigation.
- **Own-zone list:** `ownTimeZoneChoices()` is built from the country data plus UTC, not `Intl.supportedValuesOf`, which here has `Asia/Calcutta` but neither `Asia/Kolkata` nor `UTC`. The browser check found this. The client form keeps its list (its country's zones come first, with today's names).
- **Checked by hand in Edge (headless), with fake rows removed afterwards:** Settings save, both zones on the card, badge, refused edit, Saturday reschedule moving to Monday 09:00 New York, approve moving to Scheduled, skip and the empty state, desktop and phone. A live browser check caught a phone bug the tests couldn't (the button row ran past the card); fixed.

### Connect Telegram (4 Nov 2026)

- **One app endpoint for every Telegram update:** a bot has only one webhook, so `03_approval_handler` has one Telegram Trigger and relays each update to `POST /api/internal/telegram/update` (Bearer `INTERNAL_API_TOKEN`). The app decides and answers with the reply for n8n to send. This matches the drafter and the AI router: the logic lives in the app, where it's tested, and n8n stays a thin relay.
- **The bot token stays in n8n:** the app never holds it, only the public `TELEGRAM_BOT_USERNAME` for building the link (security rule 1, least access).
- **The code:** 256 random bits (43 base64url characters, inside Telegram's 64-character limit), good for 15 minutes and one use. Only its SHA-256 is stored. A plain hash is enough because the input is random, so there's nothing to guess. On `users` (migration 011) rather than a new table: one live code per user follows from the column, and a new link replaces the old one.
- **Service role for this one write:** when `/start` arrives there's no signed-in user, and the code is the only proof of who the chat belongs to. The rules allow `service_role` for n8n-facing handlers, once the bearer token has been checked. This widens the M3 note that only the webhook route imports `lib/service-db.ts`.
- **Refused:** a group or channel chat (its members would see the cards), and a chat already linked to another account. The second doesn't use up the code, so the freelancer can still connect from another chat.
- **Disconnect added:** the spec says Telegram is optional and has no way to opt out afterwards. It clears the chat and any live code.
- **Logs and events:** neither the code nor the chat ID is logged or put in an event.
- **`WEBHOOK_URL` added to compose:** n8n registers the Telegram webhook with this address, so a tunnel alone isn't enough. It defaults to n8n's own default, so nothing changes until it's set.
- **Checked for real, with throwaway values passed in the shell:** browser click, deep link, relayed `/start` against real Postgres as `service_role`, wrong token, unknown and reused codes, the page flipping to connected, and disconnect. **Not yet run against real Telegram:** that needs your bot and a tunnel (`docs/NEEDS_YOU.md`).

### Telegram cards (4 Nov 2026)

- **The app decides, n8n carries out:** both the bot's updates and a one-minute card run go to the app, which answers with a list of steps (`sendCard`, `sendText`, `editText`, `answer`). n8n has one fixed Telegram node per step, so nothing in a draft can add a button. **Spec detail changed:** the spec names the Telegram node's send-and-wait operation. That pauses a workflow per draft and keeps the decision inside n8n, which can't share the Outbox's checks or expire a button when the Outbox acts first. Spec updated.
- **The workflow JSON is written by hand from a small script, not exported from the UI:** the n8n rule prefers the UI for large graphs, but the UI needs your bot credential, which doesn't exist yet. It's 11 nodes. **Its Telegram nodes haven't run yet:** the first live run with your bot is what proves their parameters (`docs/NEEDS_YOU.md`). If one is off, fix it in the UI and export.
- **One path for every decision:** buttons call the same `approveDraft` and `skipDraft` as the Outbox, as the freelancer (RLS), so a double approve, an unpayable invoice and a broken draft behave the same everywhere. The service role only finds which freelancer a chat belongs to.
- **Taps:** a chat that isn't linked gets no answer and changes nothing (the spec's "ignored"). Another freelancer's linked chat can't act on the draft even with its id: RLS hides it.
- **Card hand-over:** a card is marked when handed to n8n, then again only if Telegram hasn't confirmed it after 10 minutes. Without this, a failed confirmation would resend the card every minute. A rare crash between sending and confirming can repeat a card; that's harmless, since either copy's buttons act on the same draft.
- **Confirmation wording (spec detail):** the spec has the bot say "Sent at 10:00 client time". Approval only records the decision and sending is M7's, so the card says "Approved. Sends <time>" for now, which is what's true. M7's sender should confirm the real send.
- **Plain-word edits:** Edit marks the draft on `users.telegram_editing_reminder_id`, and the next message from that chat is the note. One edit takes one note, so later messages do nothing, and no typed message can approve. The note is quoted to the model as data (`<` escaped, so it can't close its tag), at most 1000 characters, and never logged or stored.
- **No template fallback on a redraft:** the answer goes through the same checks as any draft. If no model gives a good one, the current draft stays and the freelancer is told. Falling back would throw away wording they had already seen and asked to adjust.
- **Long drafts:** over 4096 characters the card is a preview with a pointer to the Outbox. Text is sent plain (no `parse_mode`), so a draft can't use Telegram formatting.
- **`APP_PUBLIC_URL` (optional):** used for the Outbox link in messages. With nothing set, they name the Outbox instead. The link is in the text rather than a URL button, because Telegram refuses non-public URLs on buttons.
- **Checked for real, with fake rows and throwaway values, removed afterwards:** pending, delivered, a foreign tap, Edit, approve, a double approve, skip and a typed "approve", against the real routes and Postgres. The plain-word redraft ran through **your local Ollama model** (`llama3.2`, saved on the demo user), and passed the checks. The wording was a little clumsy (a repeated sign-off), which is why every redraft still waits for approval.

### Sync (4 Nov 2026)

- **A button works only on the card showing the current wording (safety rule added beyond the spec):** a tap's message id must match the reminder's current card, and that card must not be stale. Otherwise an old card's Approve could approve wording the freelancer was never shown, after an edit in the Outbox or a redraft. An unconfirmed card can't approve either, for the same reason. This replaces the earlier note that either copy of a repeated card works: an older copy now says it's out of date.
- **A change in the Outbox replaces the card:** an edit or a new send time marks a live card stale at once, and the next one-minute run closes it and sends a new one. Editing the old card in place would keep an old message looking current further up the chat.
- **Expiring:** the next run changes a handled draft's card to "Already handled in dashboard", once, whichever way it was handled, including when a payment stopped it. The buttons stop working at once, because every tap re-checks the draft: the text can lag by up to a minute, the protection can't.
- **Marked when handed to n8n, not when Telegram confirms:** a failed text change leaves old words on a card whose buttons already refuse, which is harmless, and it can't repeat every minute. A failed nudge isn't retried: the draft is still held and still in the Outbox.
- **The nudge:** `nudgeHours` is a schedule setting (default 24, 1 to 168), merged like the others and editable in `ScheduleForm`. It counts from when the card was handed over, once per card, so a new card gets its own. It only sends the freelancer a message, and nothing in this path can approve or send. Spec table updated.
- **The live Outbox:** the open page refreshes every 10 seconds while visible, so a Telegram approval moves it on its own (demo step 3). A refresh keeps page state, so an edit in progress isn't lost.
- **Bug found by these tests, fixed in its own commit (`22a3adf`):** saving an edit in the Outbox put the request's `action` field in the stored draft. The strict schema then refused it, so an edited draft could only be skipped. Nothing unsafe could go out, because it failed closed. The earlier test used `toMatchObject` and the browser check only tried a refused edit; a test now edits, lists and approves.
- **Checked for real, with fake rows and throwaway values, removed afterwards:** with the Outbox open in Edge, a hand edit, a refused tap on the old card, the replacement card, a relayed Telegram approval moving the page on its own after 9 seconds, an Outbox approval expiring the new card, and a tap on it. `03_approval_handler` imports into n8n (inactive). **Not run:** its Telegram nodes against real Telegram, which needs your bot.

## M7 Sending and replies

### Security rules 7 and 8 changed, approved by the user (4 Nov 2026)

- **Rule 7, Least access. Question:** the rule said "read on invoice threads only", but Google has no scope limited to some threads. **Choice:** the scopes are `gmail.send` and `gmail.readonly`, and the limit moves into code: the app reads only threads whose IDs it stored when sending, covered by tests, and never lists or searches the mailbox. **Why:** the reply listener can't read anything without a read scope, so the old wording couldn't be met as written. The Google token itself can read the whole mailbox, which makes encrypting it and the code limit the protection.
- **Rule 8, Sandbox only. Question:** the rule banned real email from dev, but sending can't be proved without one. **Choice:** PayPal live stays banned and tests never send real email. In dev, real Gmail sends go only to addresses in `DEV_EMAIL_ALLOWLIST`, which is empty by default, meaning nothing sends. Anything else is refused and logged. **Why:** it allows a real end-to-end check while a mistake can only reach an address the user listed.
- **Updated:** `CLAUDE.md` (rules 7 and 8, and the Stack line), and `docs/MVP-spec.md` (Stack table and Security section).

### Connect Gmail (4 Nov 2026)

- **Fixed by the user:** Settings > Integrations, the redirect URI `http://localhost:3000/api/integrations/gmail/callback`, offline access, the env names, and the refresh token encrypted with `lib/crypto.ts`.
- **The state:** 256 random bits, 10 minutes, one use, and only its hash is stored on the user. It's used up only when it matches, so a stray request can't cancel a connection in progress. A found bug: the first version used it up on any callback.
- **`prompt=consent` on every connect:** Google gives a refresh token only on consent, and a reconnect after the 7-day expiry needs a new one.
- **The address comes from `profile`:** that needs no extra scope, and it's what the `From` header must match.
- **Both scopes must be granted:** Google lets a user untick one. Without `gmail.readonly` the reply listener would fail later and silently, so it's refused at connect.
- **The client has no list or search:** it can send, read the profile, read one of our messages by ID, and read one thread by ID. A test reads the source and fails if any other Gmail path appears.

### Sender (4 Nov 2026)

- **A claim before Gmail, released only on a certain failure:** `send_attempted_at` is committed before the call. A clear refusal (4xx, 429, token failure) can't have sent anything, so it's released and retried. No answer, or a 5xx, might have gone out, so it's held as `unknown_outcome` and never repeated by itself. Gmail has no idempotency key, and the rules forbid searching the mailbox to check, so a person decides: the card offers Send again and Stop this send. A claim older than 15 minutes means the process died before recording, and is flagged the same way.
- **Nothing is dropped:** every hold keeps the reminder approved, with a reason on its card. The one exception is an invoice that can no longer be paid, which is stopped: a reminder for a paid invoice must not go out, whatever happens later.
- **Order of checks:** a reason worth acting on comes before the window, so the card says "Gmail isn't connected" at night too, rather than nothing until morning.
- **The allowlist applies everywhere, not just in dev:** the app refuses to run in production until real sign-in exists, so there's no production path to exempt yet. When there is, that's a change to rule 8 for you to approve. Empty means nothing sends. A refusal is logged once per reminder, without the address.
- **`invalid_grant` drops the token:** it's dead. Status becomes `needs_reconnect`, sends hold, and the next Telegram run says so once. Reconnecting clears that, and held reminders go on the next run.
- **Thread, subject and headers:** the first send has no `threadId`, and stores what Gmail returns, plus the subject. Every follow-up sends that `threadId` and subject, `In-Reply-To` the latest message on the thread, and `References` the chain (first plus latest nine). Gmail requires the matching subject to keep a message on a thread, so the Outbox shows the thread's subject on a follow-up, and its field is read-only.
- **Message-ID:** we set our own and then ask Gmail for what it recorded, since Gmail's is what replies refer to. If that lookup fails, the mail has still gone, so ours is stored rather than risking a repeat.
- **Telegram stays in Approval handler:** `04_sender` has no Telegram nodes. The one-minute run reads `sent_at` and edits the card to "Sent ✓ <time>", replacing whatever it said. It runs before the "already handled" step, so a sent card goes straight to Sent.
- **A hold column isn't read yet:** `onHold` is wired through and stays false until the reply listener adds it.

### Scheduler (4 Nov 2026)

- **Added to M7 (not a scope change):** the spec has the scheduler, and the M5 drafter's note says it comes in M7, but `docs/FEATURES.md` had no item for it. Without it nothing creates a reminder, so the sender would have nothing to send. Item added to the list.
- **Plans a day ahead:** a reminder is created once its send time is within 24 hours. Drafting right at send time would leave no time to approve it, and earlier would quote stale details.
- **One reminder in progress per invoice:** the next one is worked out only after this one is sent or skipped, using `nextSend`. A unique partial index enforces it, so two overlapping runs can't double-plan.
- **It runs the drafter directly:** same code and same router as `02_drafter`, which stays as a relay for calling one reminder by hand. n8n calling a sub-workflow per reminder would add nothing, since the logic is in the app.
- **Ten drafts a run:** a local model can take a minute each, and the rest wait for the next hour rather than timing out. Draft failures are logged and retried without stopping the others.
- **Auto-send Tier 1 is honoured:** the setting exists on the schedule form, so ignoring it would be wrong. It approves Tier 1 only, and only after the draft has passed every check. `approved_via` stays empty, and the event records `auto_send_tier1`. Tier 2, Tier 3 and courtesy always wait for a person.
- **Retainers wait for M8:** only milestone invoices are planned, because the drafter refuses retainer reminders until then.

### Reply listener (4 Nov 2026)

- **A conflict in the docs, settled for the security rule (please check this one):** the spec's table said a promise "pauses until the day after" and out of office "reschedules", and that the AI "can pause". Rule 4 says nothing in a reply can change a schedule by itself and the AI may only classify and suggest, and you repeated that for M7. Rules win. **Any reply puts the invoice on hold**, whatever it says: that doesn't depend on the text, and can only delay a reminder, which a client could do anyway by not paying. The AI's reading becomes a suggestion, and the pause, split or resume happens when you tap. Spec table reworded. This costs one tap per reply, and it means a client can't move a schedule by writing something clever.
- **`threads.get` only, no `history`:** you allowed either, but `users.history.list` returns changes across the whole mailbox, which is what rule 7 rules out. Reading each stored thread is simple and enough at this scale. Only unpaid invoices' threads are read, at most 200 a run, every 5 minutes.
- **Reads are limited twice:** thread IDs come from one query, on what the sender stored, and the client has no way to list or search. A test puts an unrelated thread in the mock mailbox and checks it's never requested.
- **Untrusted text:** the reply goes to the model as quoted JSON, with `<` escaped, so it can't close its tag. It's stored and shown only as text, and never logged or put in an event. A test uses a model that obeys the attack, and checks status, amount, due date, pause and approval are unchanged.
- **Dates from the AI are only offers:** a date is offered only if it's after today and within a year. A real model invented today's date for a promise with no date, and this check caught it. An offered date is still only applied when you tap.
- **Classifier check, with a real model by hand (`llama3.2`, local):** two runs of the 16 samples, with one prompt change between them: 14 labels right, then 13, so results vary. Misses: "next Friday" read as a split, a tag-injection attempt read as "paid elsewhere", and "mark this invoice as paid" read once as a dispute. It also invented today's date for a promise with no date. All harmless by design: no run changed anything, and an invented date of today isn't offered. A small local model will misread replies, which is why nothing depends on its reading. The mock-model test proves the pipeline, as the testing rule asks, not the model's judgement.
- **One hold per thread:** after a split, several invoices share a thread, so a reply holds them all, and a reply is filed against the earliest unpaid one.
- **After reviewing:** "Keep on hold" leaves it held, listed under "Reminders on hold" in the Outbox with Resume. A pause lifts the hold and resumes on its date.
- **Telegram reply cards aren't edited when handled in the dashboard:** there's no message id to edit, because that would need another report-back step. The buttons stop working at once and say "Already handled in dashboard" if tapped, which is what rule 3 asks.

### Split of the unpaid remainder (4 Nov 2026)

- **Amounts come from the app and the freelancer, never the AI:** the first offer is two even parts from the real unpaid total. The only thing the AI can contribute is a date, as an offer. The server checks the total against what's unpaid when you approve.
- **Settled in the dashboard, not on Telegram:** money and dates need a proper form. The Telegram button points to the Outbox.
- **A split can be offered on any reply:** if the AI misreads a request, the freelancer isn't stuck.
- **Order, so nothing with money on it is ever cancelled:** every invoice's status is checked at PayPal first, then all are cancelled, then one transaction saves the cancellations, plan and new drafts, then each is created and sent. One paid invoice stops everything before anything is cancelled. A failure later resumes from the saved plan, using the same request IDs.
- **Numbering continues after settled installments:** with installment 1 paid and a new split of 3, the new ones are "2 of 4", "3 of 4", "4 of 4". The old plan is marked cancelled, and the paid invoice keeps its link to it.
- **Same thread:** new invoices inherit the thread and subject, so the client keeps one conversation.

### Checks and n8n at the end of M7 (4 Nov 2026)

- **Route-level tests added:** handler tests inject their dependencies, so a route that imports or calls something wrongly would pass them. `tests/api/m7-routes.test.ts` imports the real route files. It settled a 500 on Connect Gmail in the running dev server, which held a stale copy of `env.ts`: the route itself is right.
- **The test time allowance is 60 seconds:** with Docker's stack and a dev server running, PGlite setup passed the old 15. It's only a limit: assertions are unchanged.
- **Workflow credentials:** repo files keep placeholder credential ids, since ids are per n8n instance. Importing one needs its credentials picked, or mapped as I did for yours. n8n needs a restart after a CLI publish.
- **Three workflows stay inactive until Gmail works:** Scheduler would start real AI drafts, and Sender and Reply listener have nothing to do yet. That's your call.
- **n8n warns that `WEBHOOK_URL` is deprecated** in favour of `N8N_WEBHOOK_URL`. It still works, and you set this name, so it stays for now.

### A live Telegram check you can repeat (4 Nov 2026)

- **Why:** the one-off test draft had been handled in the Outbox before the chat was linked, so no card could ever go out for it, and nothing showed that. `npm run telegram:test` makes a fresh waiting draft and waits for Telegram's confirmation, so it says which step failed: chat not linked, n8n not collecting, or Telegram not confirming.
- **Choice: its own fake client, not a seeded one.** The address is on the reserved `.example` domain, so approving can't email anyone even with Gmail connected, and real clients are never touched. Fixed ids mean a repeat run replaces the draft and `-- remove` deletes exactly those rows and their events. It refuses any database that isn't local.
- **The earlier draft is gone:** the first run replaced it, since it used the same project id. Lumen Labs itself stays.
- **What "passed" means:** n8n reported the message id Telegram returned. It proves the bot sent the card, not that you tapped it.

### Gmail's env names (4 Nov 2026)

- **Changed at your request:** the OAuth values are now `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`, matching your local env file. The M7 choice was `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and the old names are no longer read.
- **Kept:** `GOOGLE_AUTH_URL` and `GOOGLE_TOKEN_URL` in `lib/gmail.ts`, since they are Google's own addresses, not settings.

### A live Gmail check you can set up (4 Nov 2026)

- **At your request:** `npm run gmail:test` makes a client on the first `DEV_EMAIL_ALLOWLIST` address and a USD 5.00 sandbox invoice, through the app's own API. It reads that one variable through `process.env` and prints the address masked. It refuses to run if the client already exists, so a repeat can't make a second PayPal invoice.
- **Choice: due on receipt, with the send window always open, on this client only.** The scheduler then plans a real courtesy reminder straight away, and an approval goes out whenever it's tapped. Nothing else's schedule changes.
- **Sender is now active.** Without it an approved draft never goes out. Scheduler and Reply listener stay off.
- **Running Scheduler once:** `n8n execute` can't start a workflow with only a schedule trigger, so I added a manual trigger to the inactive workflow, ran it once, and imported the original back.

## M8 Retainers and maintenance

### Retainers (4 Nov 2026)

- **A failed charge gets a real invoice:** every reminder carries a pay link, so "the normal escalation" needs one. It's created once per cycle, however often PayPal retries.
- **The double-charge risk, and how it's handled (please check this one):** after a failed charge the client can pay the invoice, and PayPal can also succeed on a retry. Three choices follow. Plans set `auto_bill_outstanding: false`, so PayPal never bills the balance by itself later. When a payment arrives and PayPal shows nothing outstanding, open invoices for failed charges are cancelled and their reminders stop. PayPal is asked first, so an invoice with money on it is never cancelled, and you're told to check for a double payment instead. What remains: if a client pays the invoice and a retry then also succeeds, they've paid twice, and only a refund fixes that. The app tells you, but doesn't refund.
- **Why outstanding balance decides, not the event:** a later cycle's payment shouldn't cancel an earlier unpaid invoice. PayPal's `outstanding_balance` tells those two cases apart.
- **PayPal's state is read fresh:** as with invoices, an event only says which subscription to look at. A late or repeated event can't move anything backwards, and amounts come from our own row.
- **PayPal suspends after 3 failures in a row** (`payment_failure_threshold: 3`): the charge and its two retries.
- **The approval link is shown, not emailed:** the spec doesn't say how it reaches the client, and adding a new kind of client email is more than it asks for. You send it on yourself.
- **No "new link" button:** PayPal's approval links can lapse. If one does, cancel the retainer and create it again. If the client still approves the old link after that, the app cancels that subscription at PayPal and tells you.
- **A start date can't be in the past:** back-dating would invoice cycles nobody agreed to, and PayPal refuses a past start for auto-pay anyway. It's judged in the client's time zone.
- **Catching up:** invoice cycles missed while the scheduler was off are created, oldest first, up to 12 a run. A cycle you cancelled doesn't come back.
- **Due dates:** each cycle's invoice follows the merged payment terms from the charge date. A fixed-date term can't repeat, so it means the charge date. A failed charge is due on its charge date, so the tiers count from when it failed.
- **A reply on a retainer invoice can't be split:** splits belong to milestones, and each cycle stands alone. The suggestion becomes "keep on hold", and you decide as usual.
- **Added beyond the list: deleting a client is refused while auto-pay is live.** Otherwise PayPal would keep charging them with no record in the app. The message says to cancel the retainer first.
- **The webhook handler gained `runAsUser`:** the follow-up after a verified event (creating that cycle's invoice) runs as the retainer's owner under RLS, not as the service role.

### Maintenance and renewal reminders (4 Nov 2026)

- **A heads-up is a row in `reminders`, with no invoice:** that's how it gets the normal approval, Outbox, Telegram card, edit, skip, send window, allowlist and sender for free, rather than a second path that could drift. A reminder now belongs to exactly one invoice or one task, enforced by a check. No button can send: Tell the client only makes a draft, and a test checks the workflow has no step that reaches Gmail or the sender.
- **No PDF on a heads-up:** there's no invoice. The email builder's `pdf` stays a required argument, and null must be passed on purpose, so an invoice reminder still can't lose its attachment by accident.
- **Replies to a heads-up aren't read:** Rule 7 and the spec cover invoice threads. The reply lands in your Gmail as normal. The sent message is recorded, for the timeline in M10.
- **A heads-up stops if the job moves:** it quotes a date, so marking done or rescheduling skips one not yet sent, and the sender also stops one whose date no longer matches.
- **Create invoice makes a small project of its own for each due date:** adding a milestone to the original project would break "milestones must equal the project total", and a new kind of invoice source would have to rebuild deposits, PDFs and reminders. Its title names the job and date, and it copies the original's terms and late-fee clause. It shows up under the client's projects, which is a small cost. A fixed-date payment term becomes due on receipt, since that date doesn't apply to repeat work.
- **On Telegram, Create invoice is the whole amount:** a deposit needs a typed amount, so that's in the dashboard. The invoice has no email: PayPal sends nothing, and its reminders wait for approval as usual.
- **Snooze is 7 days on both screens.** Reschedule, which needs a date, is in the dashboard only.
- **Notices start at 09:00 in your own time zone:** these go to you, and an hourly scheduler would otherwise tell you at midnight. If it catches up past two lead days, you get one notice, not two.
- **"Scheduled" dates roll forward:** marking a job done very late counts on from its original date until the result is in the future, so you aren't told at once about a date already gone.
- **Double taps:** on Telegram a closed card's buttons do nothing. In the dashboard, Mark done sends the date on screen, and a second click is refused.
- **To change a job's cost or repeat, stop it and add it again.** There's no edit form: the spec asks for snooze and reschedule, and that keeps this smaller. Say if you want one.
- **New Telegram step `sendMaintenance`:** an existing step can't carry four buttons. The labels are fixed in the workflow, so nothing in the data can add one.

### Upcoming list (4 Nov 2026)

- **One total per currency, never converted, as you asked:** a converted total would need a rate from somewhere, and would be a number that isn't in your records.
- **A job with no estimate isn't counted, and the list says how many:** counting it as zero would make the total look complete when it isn't.
- **"Expected income" includes every estimate on a job or renewal:** the spec calls these costs, and a renewal could be something you pay yourself. There's no field saying who pays, so the list counts it as billed to the client. Say if you'd like a choice per job.
- **What's listed:** retainer charges only while a retainer is active, so one waiting for approval or suspended isn't counted. A job already overdue shows once, at its due date.
- **The window uses your own time zone,** because this list is for you. Each retainer's charge dates are calendar dates, so they don't shift.
- **Rows fold the type and client under the name:** five columns overflowed a phone by 74 pixels.

### A fixed tunnel that exposes only /webhook/* (4 Nov 2026)

- **The problem:** the cloudflared quick tunnel changes address on every restart, which breaks PayPal's webhook and Telegram's, and it exposes the whole n8n editor to the internet.
- **Choice: ngrok's free dev domain, with a traffic policy** (`gateway/ngrok-policy.yml`). Anything outside `/webhook/` gets a 404 from ngrok's edge, before it reaches your PC.
- **Why not a named Cloudflare tunnel:** its ingress rules do the same job well (`path: ^/webhook/`, then a final `service: http_status:404`). But its hostname is routed through Cloudflare DNS, which as far as I can tell means owning a domain on Cloudflare, and nothing here shows you have one. It's the better choice if you do, or once this is deployed, since it has no free-plan limits.
- **What was checked, and what wasn't:** ngrok's docs list one assigned dev domain, up to 5 policy rules and about 1 GB a month on the free plan, which is plenty for webhooks. Its two pricing pages don't fully agree, so check before relying on those numbers. Its warning page is for browser HTML traffic, so PayPal and Telegram shouldn't see it, but I haven't run any of this: the `curl` checks in `docs/NEEDS_YOU.md` and a real delivery will show it.
- **Rule details:** `/webhook-test/` and `/webhook-waiting/` don't match `/webhook/`, so they stay closed. Paths with `..` or `%` are refused too, since something further on might read them as outside `/webhook/`. The only production webhook here is PayPal's, which verifies every delivery, and Telegram's, whose path n8n generates.

### Publishing workflows is now your step (4 Nov 2026)

- **What happened:** you asked me to publish Scheduler, Sender and Reply listener once the live check passed. My command to publish them and restart n8n was refused by the permission check as a production deploy. An earlier publish of "PayPal webhook" had gone through. Rule 10 says to stop that approach, so I didn't split it up or try another route.
- **Choice: `npm run n8n:go-live`, which you run.** It also carries the updated Approval handler, which has per-instance credentials that are fiddly to map by hand. Its dry run reads only names, types and ids, and I ran that. It never prints a credential.
- **Sender was already active,** so it isn't in the script.

### Your answers to the M7 questions (4 Nov 2026)

- **Replies:** kept as built, as you confirmed. Any reply holds the invoice, and you decide with a tap.
- **M4's Done-when line:** your message still held the template text for this answer, so I changed nothing and asked again in `docs/NEEDS_YOU.md`.
- **Live check slots:** the Telegram and email answers were template text too. I read the state from the database instead of assuming: the send had gone through the Outbox.

### Double payment: suspend first (4 Nov 2026, your decision after M8)

- **What changed, as you asked:** a failed charge now suspends the subscription in PayPal before any catch-up invoice exists, and reactivates it once that invoice is paid. PayPal's own copy must say SUSPENDED first: even a draft row waits for that. This replaces the M8 approach, which relied on cancelling an invoice after a retry.
- **How "a retry won" is decided:** PayPal shows a payment later than the last failure, and nothing outstanding. Outstanding alone can't say it, because PayPal's docs say a failed charge reaches that balance only after its retries run out.
- **A charge already under way:** it can land between PayPal's reply and the suspension. So PayPal is read again afterwards: if it collected, there's no invoice and auto-pay is reactivated. If an invoice had gone out, it's cancelled and its reminders stop. An invoice with money on it is never cancelled: the "may have paid twice" warning stays as the backstop for this.
- **What this rests on, and what isn't proven:** PayPal's docs say "When a subscription is paused, or soft-canceled, PayPal will stop processing payments until it is reactivated." They don't say whether a retry resumes after reactivation, or whether cycles missed during a pause are billed. A real failed charge can't be produced in the sandbox with a valid signature, so neither is tested against PayPal. If a retry did resume after a paid invoice, the warning fires.
- **What the real sandbox showed:** on a subscription nobody has approved, activate answers 422 `SESSION_STATE_NOT_VALID` ("Buyer has not agreed"), which proves its path. Suspend answers 404 `INVALID_RESOURCE_ID`, as cancel does, so suspend's path isn't proven until a sandbox buyer approves a subscription.
- **Charge dates during a pause aren't billed, and aren't invoiced either:** invoicing them could double-charge if PayPal bills missed cycles on reactivation, which its docs don't rule out. The alert tells you to check. It's your call whether you'd like invoices for those (in `docs/NEEDS_YOU.md`).
- **Only a paid invoice reactivates:** one cancelled unpaid leaves auto-pay suspended, since nothing was paid. Cancel the retainer, or reactivate it in PayPal.
- **Reactivating by hand in PayPal during a hold isn't blocked:** the app can't stop that, and it would let new charges run.

### Every date in a draft must be in the facts (4 Nov 2026, your decision after M8)

- **What it finds:** day-month-year in either order, with or without ordinals, "of", commas and dashes; ISO; numeric with `/`, `.` or `-` and two- or four-digit years; word ordinals ("the fifteenth of May"); month and year; "by May"; "on the 15th"; weekdays, alone or in front of a date; and relative dates (`lib/draft-dates.ts`). It covers the subject too.
- **The same date in another format passes,** including the "May 15, 2027" the local model wrote. `05/06/2027` passes if either reading is in the facts.
- **A day or month the facts don't have is refused,** so "in May" as a fact doesn't allow "15 May". A year may be added only when the fact has none. A wrong weekday makes it a different date: "Friday 15 May 2027" fails, since it's a Saturday.
- **Relative dates count as dates:** "tomorrow", "next Friday", "within 7 days" and "today" fail. `within 14 days` passes only when the terms are Net 14. This can cost a model answer ("I'm writing today"), and the retry and fixed template catch that. The prompts now say so.
- **Names are quoted, not scanned:** a project called "March 15 launch" can be named. "You may pay", "my 2nd reminder", "24/7", invoice numbers and links aren't dates.
- **Where the freelancer's own words count (please check this one):** you said to reject any date not in the facts. I kept one exception. In a plain-word edit on Telegram, a date named in the note is allowed for that redraft. Your spec's own example is "mention the 15th", the redraft prompt already says "in the facts or the note", and strict checking would answer "I couldn't redraft that" to that example. The result still waits for your approval. A date already in a draft can also stay through a hand edit, or fixing a typo would be refused. A new date typed in the Outbox is refused, as a new amount is. Say if you want either tightened.

### The auto-pay approval link is an email draft (4 Nov 2026, your decision after M8)

- **What changed, as you asked:** setting up auto-pay now makes an email draft with the approval link as its only link. It goes through the normal approval, Outbox, Telegram card, allowlist and sender. The check that refuses any other link is the same kind as the pay link's.
- **The link no longer shows on the Retainers screen,** only inside the draft, so the one path to the client is the approved one. The screen says where the email stands.
- **It's drafted once by itself.** After you skip it, nothing comes back unless you press Draft the approval email. Skipping is your decision, and a retried setup mustn't undo it.
- **It stops if it's out of date:** the client approving, or you cancelling, stops a draft not yet sent, and the sender checks again just before sending.
- **Same path as a heads-up:** both are "an email with no invoice" (`lib/standalone-draft.ts`), so the sender, Outbox and redraft have one extra path, not two. No PDF, and replies to it land in your Gmail unread by the app, as rule 7 covers invoice threads.
