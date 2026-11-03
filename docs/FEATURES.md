# Feature list and build order

Work top to bottom. Each item has "done when" checks; tick the box only when every check passes and `npm run check` is green. Section names in brackets point to `docs/MVP-spec.md`.

## M0 Foundations

- [x] **Repo tooling:** root `package.json` with npm workspaces, TypeScript strict, ESLint, Prettier, vitest, Playwright; scripts `dev`, `test`, `test:e2e`, `lint`, `typecheck`, `check`, `db:migrate`, `db:seed`.
  - Done when: `npm run check` runs (and passes) on the empty project.
- [x] **Local stack:** `docker-compose.yml` runs n8n, Postgres, LiteLLM, plus Ollama as an optional profile.
  - Done when: `docker compose up -d` starts all services and each health check passes.
  - Note: Postgres, n8n and LiteLLM verified healthy. The Ollama profile is defined, but its runtime health check is deferred to M4 (agreed).
- [x] **Database:** `db/migrations/001_init.sql` creates the 11 tables from [Data model], with foreign keys, timestamps, row-level security per user, and money in integer cents.
  - Done when: migrations apply to an empty database, and a test checks that each table and its RLS policy exist.
- [x] **Secrets helper:** `lib/crypto.ts` encrypts and decrypts with `ENCRYPTION_KEY`; env is loaded and checked with zod at startup.
  - Done when: round-trip tests pass, and startup fails with a clear message if a required env var is missing.

## M1 Schedule engine [Project setup]

- [x] **Settings merge:** account, then client, then project, then milestone; the most specific wins. Defaults match the spec table.
  - Done when: tests cover each layer overriding the one above.
- [x] **Next send time:** pre-due, grace period, tier boundaries (1 / 8 / 22), interval, max per tier, send window in the client's time zone, pause and snooze.
  - Done when: tests cover each rule, a weekend, a DST change, and a client 12+ hours ahead of the freelancer.
- [x] **Validation:** ascending tiers, interval of at least 1 day, a warning (not an error) when the due date is before the deadline.
  - Done when: invalid settings are rejected with field-level messages.

## M2 Clients, projects and milestones [Milestones]

- [x] **Clients CRUD** with country and time zone (auto from country, editable).
- [x] **Projects:** new project form with deadline, terms, schedule and currency (`ScheduleForm`).
- [x] **Milestones (optional):** amount or %, deadline, acceptance window, payment mode (`MilestoneEditor`).
  - Done when: totals must equal the project total (or 100%), out-of-order deadlines warn, and the lifecycle statuses match the spec.

## M3 PayPal invoices and webhooks [PayPal integration]

- [ ] **Invoices and installments:** one PayPal invoice per milestone or per installment: create, send, cancel. No PayPal partial payments anywhere. Installment plans of 2 to 12 (exact totals, last installment absorbs the rounding remainder): set up on a pay-on-invoice milestone, or a deposit (installment 1 at kickoff, the rest on delivery). Each installment invoice says "Installment 2 of 3", the milestone total, paid so far and the other due dates. New migration for the installment fields and `installment_plans`.
  - Done when: sandbox integration tests pass; a retry with the same `PayPal-Request-Id` creates no duplicate; no PayPal request contains `partial_payment`, `allow_partial_payment` or `minimum_amount_due`; a milestone with installments goes Partially paid, then Paid; an installment plan with anything paid can't be cancelled.
  - History: first built with PayPal partial payments, which the sandbox refused for this account's country. Reworked for installments (`docs/CHANGE-installments-and-templates.md`, approved 3 Nov 2026).
- [x] **Webhook handler** (n8n `06_paypal_webhook`): verify the signature, then update invoice and milestone status (Paid, Partially paid, refund, dispute).
  - Done when: an unsigned or forged event is rejected, and paid stops all pending reminders for that invoice.
  - Note: both checks pass in tests (PayPal mocked), and the real sandbox answers FAILURE for a forged delivery. A live delivery through n8n hasn't run yet: it needs a public URL (see `docs/NEEDS_YOU.md`).

## M4 Bring your own AI [Bring your own AI]

- [ ] **AI settings screen:** provider presets, base URL, key (encrypted), model, optional per-task models.
- [ ] **AI router** (n8n `07_ai_router`) via LiteLLM, with the fallback order local, then cloud (if allowed), then template.
- [ ] **Test connection:** runs 4 sample tasks and shows pass or fail for each.
  - Done when: it works with a mock model in tests and with Claude plus Ollama by hand, and invalid JSON triggers one retry and then the template.

## M5 Drafting [Escalation engine]

- [ ] **Prompts** for courtesy, Tier 1, 2 and 3, and maintenance heads-up, each with schema-checked output.
- [ ] **Drafter** (n8n `02_drafter`): builds context (client, amount, deliverable, days overdue, terms, pay link).
- [ ] **Legal gating:** Tier 3 cites only the contract clause or `legal/statutes.json`; otherwise it's a "final notice" with a not-legal-advice note.
  - Done when: a test with a country missing from the table produces no legal citation.
- [ ] **Invoice templates** [Invoice templates]: three built-ins (Classic, Modern, Minimal) and custom HTML/CSS templates with tags; sanitised on save; live preview in a sandboxed iframe; PDF by headless Chromium with JavaScript and network off; AI fills only the text tags (`prompts/schemas/invoice-text.schema.json`); default per account, overridable per client. New migration for `invoice_templates`, `invoices.template_id` and `pdf_path`, and `clients.default_template_id`.
  - Done when: every tag fills; an unknown tag errors; values are HTML-escaped; the sanitiser removes scripts, event handlers and remote URLs; a template with a remote image is refused; PDF rendering runs with network off; AI text with an amount or a date in it is rejected; the PDF is attached to reminder emails (and to the PayPal invoice if the sandbox allows attachments).

## M6 Approvals [Reviewing drafts: Outbox and Telegram]

- [ ] **Outbox page:** filters (Waiting / Scheduled / Sent / Skipped); approve, edit, skip, reschedule.
- [ ] **Connect Telegram:** one-time code deep link that saves the chat ID.
- [ ] **Telegram cards** (n8n `03_approval_handler`): Approve / Edit / Skip; a plain-word edit triggers a redraft; drafts over 4096 characters are previewed with a link.
- [ ] **Sync:** handled in one place means expired in the other; taps from other chats are ignored; one nudge after 24 hours, then held.
  - Done when: integration tests cover approving in each place, a double approve, a foreign chat ID, and the timeout.

## M7 Sending and replies [Escalation engine]

- [ ] **Sender** (n8n `04_sender`): Gmail on the original thread, only for approved drafts, inside the send window.
- [ ] **Reply listener** (n8n `05_reply_listener`): classify (promise / installments / paid elsewhere / dispute / out of office / unclear), then branch per the spec table.
  - Installments branch: drafts a split of the unpaid remainder (amounts and due dates) for the freelancer to approve. On approval, in one step, the open unpaid invoices are cancelled and the installment invoices are created (`created_from: client_request`). An invoice with money on it is never cancelled.
  - Done when: all fixtures in `tests/fixtures/client-replies.json` are labelled correctly, no reply text can change status or amount, and an approved split replaces the open invoice with installments while a paid invoice is never cancelled.

## M8 Retainers and maintenance [Retainers and maintenance reminders]

- [ ] **Retainers:** auto-pay (PayPal Subscriptions) or invoice each cycle; handle payment-failed, suspended and cancelled webhooks.
  - Done when: a failed payment starts the normal escalation, and a cancellation alerts the freelancer on Telegram.
- [ ] **Maintenance and renewal reminders:** repeat every N months, lead days (14 and 1 by default), Telegram buttons (tell the client, create invoice, snooze, mark done).
  - Done when: mark done sets the next date (from done or from scheduled, per the setting), and a heads-up to the client goes through approval.
- [ ] **Upcoming list** (dashboard home): the next 90 days of maintenance, renewals and retainer charges, with expected income.

## M9 Milestone holds [Milestones]

- [ ] **Hold:** authorize at milestone start, capture on acceptance, reauthorize after day 3, void on cancel; warn when the deadline is more than 29 days after the hold.
  - Done when: sandbox tests cover capture, reauthorize and void.

## M10 Dashboard and demo [Hackathon demo plan, Success metrics]

- [ ] **Client timeline:** messages, replies, payments and events (the evidence timeline).
- [ ] **Metrics:** amount recovered, days late per invoice, recovery rate.
- [ ] **Demo clock** (`DEMO_CLOCK_OFFSET_DAYS`, dev only) and seed data for the $3,000 website project.
- [ ] **E2E:** a Playwright test runs the 8 demo steps end to end.

## Out of scope (Phase 2, don't build)

Cal.com scheduling, calendar view, meeting notes, transcripts, email auto-import, WhatsApp, multi-user PayPal partner onboarding.
