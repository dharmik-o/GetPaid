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

- [x] **Invoices and installments:** one PayPal invoice per milestone or per installment: create, send, cancel. No PayPal partial payments anywhere. Installment plans of 2 to 12 (exact totals, last installment absorbs the rounding remainder): set up on a pay-on-invoice milestone, or a deposit (installment 1 at kickoff, the rest on delivery). Each installment invoice says "Installment 2 of 3", the milestone total, paid so far and the other due dates. New migration for the installment fields and `installment_plans`.
  - Done when: sandbox integration tests pass; a retry with the same `PayPal-Request-Id` creates no duplicate; no PayPal request contains `partial_payment`, `allow_partial_payment` or `minimum_amount_due`; a milestone with installments goes Partially paid, then Paid; an installment plan with anything paid can't be cancelled.
  - History: first built with PayPal partial payments, which the sandbox refused for this account's country. Reworked for installments (`docs/CHANGE-installments-and-templates.md`, approved 3 Nov 2026).
- [x] **Webhook handler** (n8n `06_paypal_webhook`): verify the signature, then update invoice and milestone status (Paid, Partially paid, refund, dispute).
  - Done when: an unsigned or forged event is rejected, and paid stops all pending reminders for that invoice.
  - Note: both checks pass in tests (PayPal mocked), and the real sandbox answers FAILURE for a forged delivery. A real delivery ran through the tunnel and n8n on 4 Nov 2026: `BILLING.SUBSCRIPTION.CREATED` passed PayPal's signature check and was recorded. A real paid invoice hasn't been delivered yet.

## M4 Bring your own AI [Bring your own AI]

- [x] **AI settings screen:** provider presets, base URL, key (encrypted), model, optional per-task models.
- [x] **AI router** (n8n `07_ai_router`) via LiteLLM, with the fallback order local, then cloud (if allowed), then template.
  - Note: the routing runs in the app (`lib/ai-router.ts`, tested with mock models); `07_ai_router` relays to it. Calls use the OpenAI-compatible format, direct to each provider's compatible endpoint; the LiteLLM gateway is used through Custom URL for providers without one (see `docs/DECISIONS.md`).
- [x] **Test connection:** runs 4 sample tasks and shows pass or fail for each.
  - Done when: it works with a mock model in tests and with Ollama (`llama3.2`) by hand, and invalid JSON triggers one retry and then the template.
  - Status: done. Passes with mock models in tests (including the retry and the template), and the user ran Test connection by hand with Ollama (`llama3.2`) on 4 Nov 2026: all 4 tasks passed. It hasn't been run by hand with Claude, which is optional (see `docs/NEEDS_YOU.md`).

## M5 Drafting [Escalation engine]

- [x] **Prompts** for courtesy, Tier 1, 2 and 3, and maintenance heads-up, each with schema-checked output.
- [x] **Drafter** (n8n `02_drafter`): builds context (client, amount, deliverable, days overdue, terms, pay link).
- [x] **Legal gating:** Tier 3 cites only the contract clause or `legal/statutes.json`; otherwise it's a "final notice" with a not-legal-advice note.
  - Done when: a test with a country missing from the table produces no legal citation.
- [x] **Invoice templates** [Invoice templates]: three built-ins (Classic, Modern, Minimal) and custom HTML/CSS templates with tags; sanitised on save; live preview in a sandboxed iframe; PDF by headless Chromium with JavaScript and network off; AI fills only the text tags (`prompts/schemas/invoice-text.schema.json`); default per account, overridable per client. New migration for `invoice_templates`, `invoices.template_id` and `pdf_path`, and `clients.default_template_id`.
  - Done when: every tag fills; an unknown tag errors; values are HTML-escaped; the sanitiser removes scripts, event handlers and remote URLs; a template with a remote image is refused; PDF rendering runs with network off; AI text with an amount or a date in it is rejected; the PDF is attached to reminder emails (and to the PayPal invoice if the sandbox allows attachments).

## M6 Approvals [Reviewing drafts: Outbox and Telegram]

- [x] **Outbox page:** filters (Waiting / Scheduled / Sent / Skipped); approve, edit, skip, reschedule.
- [x] **Connect Telegram:** one-time code deep link that saves the chat ID.
  - Note: runs end to end against a relayed update on real Postgres. A real Telegram delivery hasn't run yet: it needs your bot and a public URL (see `docs/NEEDS_YOU.md`).
- [x] **Telegram cards** (n8n `03_approval_handler`): Approve / Edit / Skip; a plain-word edit triggers a redraft; drafts over 4096 characters are previewed with a link.
  - Note: the app's side runs against real routes, Postgres and a local model. The workflow's Telegram nodes haven't run yet: that needs your bot (see `docs/NEEDS_YOU.md`).
- [x] **Sync:** handled in one place means expired in the other; taps from other chats are ignored; one nudge after 24 hours, then held.
  - Done when: integration tests cover approving in each place, a double approve, a foreign chat ID, and the timeout.

## M7 Sending and replies [Escalation engine]

- [x] **Connect Gmail** in Settings > Integrations: OAuth with offline access, refresh token encrypted, reconnect on invalid_grant.
  - Note: added to this list, because the sender can't run without it. Runs against a mocked Google in tests. A real connection needs your OAuth client (see `docs/NEEDS_YOU.md`).
- [x] **Sender** (n8n `04_sender`): Gmail on the original thread, only for approved drafts, inside the send window.
  - Note: runs against a mocked Gmail in tests. A real send needs your OAuth client and `DEV_EMAIL_ALLOWLIST`.
- [x] **Scheduler** (n8n `01_scheduler`): plans each unpaid invoice's next reminder from `lib/schedule.ts` and drafts it.
  - Note: added to this list. The spec has it, but no item built it, and without it no reminder is ever created. Retainers and maintenance join it in M8.
- [x] **Reply listener** (n8n `05_reply_listener`): classify (promise / installments / paid elsewhere / dispute / out of office / unclear), then branch per the spec table.
  - Installments branch: drafts a split of the unpaid remainder (amounts and due dates) for the freelancer to approve. On approval, in one step, the open unpaid invoices are cancelled and the installment invoices are created (`created_from: client_request`). An invoice with money on it is never cancelled.
  - Done when: all fixtures in `tests/fixtures/client-replies.json` are labelled correctly, no reply text can change status or amount, and an approved split replaces the open invoice with installments while a paid invoice is never cancelled.
  - Note: labelled correctly with the mock model, as the rule asks. With a real local model (`llama3.2`), 13 to 14 of 16 labels were right over two runs; a wrong one can only mislead a suggestion, since nothing changes without you. Gmail is mocked in tests, and a real reply was read and labelled on 4 Nov 2026.

## M8 Retainers and maintenance [Retainers and maintenance reminders]

- [x] **Retainers:** auto-pay (PayPal Subscriptions) or invoice each cycle; handle payment-failed, suspended and cancelled webhooks.
  - Done when: a failed payment starts the normal escalation, and a cancellation alerts the freelancer on Telegram.
  - Note: product, plan and subscription creation ran against the real sandbox. Webhook behaviour is tested with PayPal mocked: PayPal's simulator can't produce a charge failure that passes signature checks, so a real failed charge hasn't run.
- [x] **Maintenance and renewal reminders:** repeat every N months, lead days (14 and 1 by default), Telegram buttons (tell the client, create invoice, snooze, mark done).
  - Done when: mark done sets the next date (from done or from scheduled, per the setting), and a heads-up to the client goes through approval.
  - Note: runs against real routes in tests, with Telegram, Gmail and PayPal mocked, and the screen ran in a real browser and Postgres. A real card reached Telegram on 4 Nov 2026. Tapping its buttons is on the live-check list in `docs/NEEDS_YOU.md`.
- [x] **Upcoming list** (dashboard home): the next 90 days of maintenance, renewals and retainer charges, with expected income.
  - Note: amounts come from the database only, with one total per currency, never converted.

## M9 Milestone holds [Milestones]

- [x] **Hold:** authorize at milestone start, capture on acceptance, reauthorize after day 3, void on cancel; warn when the deadline is more than 29 days after the hold.
  - Done when: a sandbox run with a buyer covers capture and void, and reauthorize is covered with PayPal mocked and by reaching PayPal's real API. A real reauthorize follows once PayPal's 3-day honor period has passed (see `docs/NEEDS_YOU.md`).
  - Status: done on that wording. The user ran `npm run hold:check` on 5 Nov 2026 and approved both orders with a sandbox buyer: capture and void passed. A real reauthorize **hasn't run yet**: `npm run hold:check -- keep` left authorization `1AY82822TV949110M` open for it, on or after 9 Nov 2026. So far reauthorize has run only with PayPal mocked, and in the real sandbox only as far as PayPal's API answering 404 for an unknown id. Also not run live: a hold's PayPal webhooks, and a hold through the app.

## M10 Dashboard and demo [Hackathon demo plan, Success metrics]

- [x] **Client timeline:** messages, replies, payments and events (the evidence timeline).
- [x] **Metrics:** amount recovered, days late per invoice, recovery rate.
- [x] **Demo clock** (`DEMO_CLOCK_OFFSET_DAYS`, dev only) and seed data for the $3,000 website project.
- [x] **E2E:** a Playwright test runs the 8 demo steps end to end.

## Redesign and landing page [docs/design/redesign-brief.md]

Presentation only: no changes to API calls, data, routes, form field names, validation or business logic. Each page is one commit, with `npm run check` and `npm run test:e2e` green, checked at 375px and 1280px in both themes.

- [x] **Foundation:** tokens, fonts, theme switch, buttons, inputs, cards, badges, nav, dotted triangle. Stop here for the user to check both themes.
- [x] **Home**
- [x] **Outbox**
- [x] **Clients** (list, new, detail)
- [x] **Projects** (list, new, detail)
- [x] **Retainers** (list, new)
- [x] **Maintenance** (list, new)
- [x] **Settings** (schedule, AI, integrations, templates)
- [x] **Landing page** at `/welcome`: own commits, GSAP and ScrollTrigger on that page only.
  - Includes the hero's Paid moment: Sent to Paid pill, then the GetPaid stamp (`public/getpaid-stamp.svg`) slams onto the example invoice and the card bounces 7px, with GSAP.
  - Done when: a Playwright check shows `/welcome` loads, its calls to action reach `/`, and it works with reduced motion.

## M11 Invoice themes, signatures, archive and history [Invoice templates, Data model, Screens]

- [x] **Three new built-in themes** (Studio, Ledger, Noir), Classic and Minimal restyled, Pay online with a QR code on all six, a thumbnail gallery, and A4 or US Letter.
  - Done when: every built-in renders every tag in tests, fits one page in A4 and Letter, and passes the sanitiser.
- [x] **Signature:** upload or typed, signer name and title, a default, and "Include my signature" on every invoice creation.
  - Done when: signature on or off is respected per invoice in tests.
- [x] **Local invoice archive:** every PDF sent to a client is kept, and a changed one is a new version.
  - Done when: a sent invoice's PDF exists in the archive at the expected path with a matching sha256, a changed one becomes v2 without touching v1, and path tests cover unsafe names and traversal attempts.
- [x] **Invoice history** on the Project and Client pages, with filters and downloads.
  - Done when: the Project and Client pages list the right invoices for the right user only (RLS test), and the Playwright demo still passes, plus a check that the Project page shows its invoices.

## Phase 2 [docs/PHASE2-PLAN.md]

### Part A: Calendar

- [x] **A1 Calendar data and feed:** migration 027, `lib/calendar-entries.ts`, `lib/calendar-feed.ts`, the items and entries routes.
  - Done when: `GET /api/calendar?from=&to=` returns entries plus every app-made date in range.
- [x] **A2 Calendar screens:** `/calendar` (month view and 30-day agenda), `/calendar/new`, `/calendar/[id]`, sidebar link, "Add to calendar" on milestones, entries on Home, the Telegram morning nudge.
  - Done when: entries can be added, edited, marked done, deleted and linked to a milestone; app-made dates open their own pages.
- [x] **A3 Export:** `.ics` export, Google and Outlook links.
  - Done when: the exported file imports into Google Calendar (the owner checks; see `docs/NEEDS_YOU.md`).
- [x] **A4 Import:** guarded fetch, ICS parsing, sources screen, 30-minute sync workflow.
  - Done when: a Google secret iCal address shows its events (including recurring ones) on the calendar and refreshes on schedule.
- [x] **A5 AI assistant:** the `calendar` AI task, answer checks, proposals with an Apply button.
  - Done when: with the owner's configured model, "What are my deadlines next week?" lists the right items, and "Move <entry> to Friday" proposes a move that applies only after a click.

### Part C: Contracts and legal tools

- [x] **C1 Facts, law table and rates:** client region and "is a business", legal name, Udyam number, `legal/statutes.json`, `legal/reference-rates.json`, `npm run legal:check`.
  - Done when: `npm run legal:check` lists every entry as unapproved with its source, and nothing is cited until approved.
- [x] **C2 Agreement builder:** migration 030, template, builder page, Agreement panel on the Project page.
  - Done when: a draft agreement for the demo project previews with the right amounts, milestones and options, and can be saved and voided.
- [x] **C3 Signing:** send through the Outbox, public sign page, signed PDF with certificate, archive, signed-copy draft.
  - Done when: an agreement can be sent (after approval), opened from the email, signed with a typed name, and the signed PDF with its certificate page is in the archive and attached to the signed-copy draft.
- [ ] **C4 Interest and final demand:** `lib/statutory-interest.ts`, `lib/final-demand.ts`, the final demand letter.
  - Done when: for an overdue demo invoice with a UK business client (rates approved in a test fixture), the draft shows the correct interest and compensation, the approved citation and the deadline, and can only be sent after approval.
- [ ] **C5 Lawyer pack:** one PDF with agreement, invoices, timeline and demands.
  - Done when: the demo project's pack downloads as one PDF with the cover, agreement, invoices, timeline and demands.

## Out of scope (not planned)

Cal.com scheduling, meeting notes, transcripts, speech-to-text, email auto-import, WhatsApp, multi-user PayPal partner onboarding.
