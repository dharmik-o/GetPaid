# M5 summary: Drafting

**All four M5 items are ticked.** Everything was built and tested with mocks (PayPal, models and Gmail through msw); PDFs use the real Playwright Chromium. As agreed, `INTERNAL_API_TOKEN` and the n8n credential aren't set yet, and the M4 Test connection box stays open until your manual test. Neither blocked M5.

## Checks

| Check           | Result                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` | Green: lint, typecheck and 860 tests (up from 636 at the end of M4). No real network calls.                                                                                                                                                                                                                                               |
| Real Chromium   | `tests/invoice-pdf.test.ts` renders a built-in to a PDF, and renders a hostile page (remote image, stylesheet, `@import`, script fetch, iframe, background) while a local server counts requests: **zero**. A one-off control run without the locks saw the requests, so the test isn't passing by accident.                              |
| Your dev server | Migration 009 applied locally. `/settings/templates`, the editor (`/new` and a built-in), and the template API answer 200. In a scripted browser, the editor flagged an unknown tag and an `onclick` inline, and its sandboxed preview filled in the sample data. `/api/internal/drafts` answers 503 until the token is set, as designed. |
| Built-ins       | Classic, Modern and Minimal rendered with sample data and checked by eye: name, client, items, totals, installment block, terms, late-fee clause and pay link all come from the record.                                                                                                                                                   |
| n8n             | `02_drafter` imports into n8n (inactive until its credential exists).                                                                                                                                                                                                                                                                     |

## What was built

**Prompts** (`bd3c804`)

- Courtesy, Tier 1, 2, 3 and maintenance heads-up prompts in `prompts/*.md`. `npm run ai:prompts` (new) copies them into the app, and a test catches drift.
- The facts go in as quoted JSON. Every value is already formatted from the database: money by the one formatter, dates as "31 Oct 2026".
- Checks beyond the JSON shape:
  - the pay link is there, exactly as given
  - there are no other links
  - every money amount appears in the facts
  - the subject has no line break
- A draft that fails is retried once, then replaced by the fixed template, the same as invalid JSON.

**Drafter** (`9abd475`)

- `POST /api/internal/drafts` (Bearer `INTERNAL_API_TOKEN`) builds the facts, runs the router, checks the draft and saves it on the reminder, acting as that user (RLS).
- It's safe to re-run: a reminder that already has a draft is left alone, and no model is called.
- It refuses when the invoice is paid, cancelled or not sent, or the reminder was already handled.
- Days overdue are counted in the client's calendar (new `daysOverdue` in `lib/schedule.ts`).
- `02_drafter` is a two-node relay, like `07_ai_router`.

**Legal gating** (`e4464d4`)

- A Tier 3 notice cites the contract's late-fee clause if there is one, otherwise a law from `legal/statutes.json` for the client's country, otherwise nothing: a plain "Final notice".
- Every reminder draft is checked for legal or fee wording it wasn't given. Tiers 1 and 2 may never cite.
- A law with a condition the app can't check (a city, MSME registration) is never cited automatically.
- Every Tier 3 draft carries `notLegalAdvice: true`; the note shows in the Outbox and Telegram cards in M6.
- The done-when passes: a client whose country is missing from the table gets no legal citation, even when the model adds one.

**Invoice templates** (`e315c6e`)

- Migration 009 adds `invoice_templates` with the three built-ins, plus the default template, business details and logo for your account, and company, address and default template for each client. Invoices get their template, PDF path and text.
- Custom templates are sanitised on save:
  - scripts, event handlers, iframes, forms and `javascript:` links are removed
  - remote images, stylesheets, fonts and `@import` refuse the save
  - only known CSS properties are kept
  - the limit is 100 KB
- Tags are logic-less Mustache, with every value HTML-escaped. An unknown tag is an error with its line number.
- The live preview is an iframe with no scripts (`sandbox=""`), under a strict Content Security Policy.
- PDFs come from headless Chromium with JavaScript off and the network off. Each PDF is stored after the invoice is sent and can be downloaded from the project page.
- The AI fills only the four text tags, and text with an amount or a date is rejected. That covers your own edits too, because every amount and date must come from the records.
- **Attached to reminder emails:** `lib/reminder-email.ts` builds the reminder email with the PDF as a required argument, ready for M7's Gmail sender. **Not attached to the PayPal invoice:** PayPal's documented Invoicing API has no file upload.
- Screens: Settings > Invoice templates (Preview, Duplicate, Set as default, and your details and logo), the template editor, the template pick and AI text on Create invoice, and an invoice-details card on the client page.

**Also:** `fix(test)` (`11cc587`) gave PGlite setup hooks the same 15 s limit as tests, after one timed out under full-suite load.

## Decisions logged (`docs/DECISIONS.md`, M5): ones you may want to look at

1. **The app drafts in-process; n8n relays.** The drafter calls the same router code `07_ai_router` relays to, so the content and legal checks get the router's retry-once-then-template rule. Spec wording updated.
2. **The default template lives on `users` and `clients`, not as `is_default` on the template.** A shared built-in can't hold one user's default. Spec data model updated.
3. **Strict text checks.** Any digit, month, weekday or money word in the invoice text is rejected, and so is any legal or fee word in a reminder that wasn't given it (including "interest"). A false alarm only means the fixed wording is used.
4. **The "not legal advice" note is for you, not the client.** It's stored on every Tier 3 draft and shown in the review screens (M6), never put in the email.
5. **Four new packages:** `mustache`, `sanitize-html`, `postcss` and `playwright-core` (1.64.1, matching your Chromium). None has an install script, and the audit found nothing new.

## Needs you (`docs/NEEDS_YOU.md`)

- **New: laws for Tier 3.** `legal/statutes.json` is empty, and the rules say I must ask before adding an entry. For each of the spec's four laws (UK 1998 Act, EU Directive 2011/7/EU, India MSMED Act, NYC Freelance Isn't Free Act), approve the exact citation sentence, an official source URL and the checked date. Until then, a Tier 3 notice cites only a contract clause, or nothing.
- **Still open, before M6:** `INTERNAL_API_TOKEN` and the n8n "App internal API token" credential. Pick that credential in both "AI router" and the new "Drafter" workflow.
- **Still open:** the M4 Test connection runs with Claude and Ollama by hand.
- **Still open:** a public HTTPS tunnel for live PayPal webhooks, and real sign-in before any deployment.

## Next: M6 Approvals

The Outbox page (Waiting / Scheduled / Sent / Skipped), Connect Telegram, Telegram cards (`03_approval_handler`), and keeping the two in sync. M6 needs `INTERNAL_API_TOKEN` and a Telegram bot token from you.
