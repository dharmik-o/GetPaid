# Phase 2 summary: the calendar (P0 and A1 to A5)

Everything in Part A is built and merged into `main`, with `npm run check` and `npm run test:e2e` green at every step. Part C (contracts and legal tools) has not been started. Meeting notes and speech-to-text were dropped on 9 Nov 2026 and aren't built.

## What was built

| Step   | What you get                                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | Decisions F1 to F10 in `docs/DECISIONS.md`, the Phase 2 list in `docs/FEATURES.md`, the superseded note on the meetings plan, `CALENDAR_SYNC_MINUTES` in `.env.example`.                                                                                                                                                                             |
| **A1** | Migration 027 (your entries, imported calendars, imported events, all with row-level security), `GET /api/calendar` returning your entries plus every date the app already knows (milestone deadlines, invoice due dates, planned reminders, maintenance, renewals, retainer charges, hold expiry), and the entry routes.                            |
| **A2** | `/calendar` with a month view, a 30-day agenda, add / edit / done / delete screens, a Calendar link in the menu, "Add to calendar" on milestones, "On your calendar" on Home, and a Telegram nudge at 09:00 on the day for entries that ask for it.                                                                                                  |
| **A3** | `.ics` export (this month, the next 3 months, or everything; notes only if you tick the box) and "Add to Google Calendar" and "Add to Outlook" on an entry. Imported events are never exported.                                                                                                                                                      |
| **A4** | Import by secret iCal address (Google, Outlook, iCloud) or an `.ics` file, read-only, refreshed every 30 minutes by a new n8n workflow, repeating events expanded, client meetings marked. The address is encrypted, never shown again and never logged, and it is fetched only through a guarded fetch that refuses private and internal addresses. |
| **A5** | An assistant on `/calendar`: ask about your calendar and it answers from it, and proposes changes to your own entries as cards you must Apply. Imported events, milestones, invoices and anything with money can't be changed by it, and a wrong date or amount in its answer is replaced.                                                           |

## Done-when checks

| Check                                                                                    | Result  | Where                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| A1: `GET /api/calendar` returns entries plus every app-made date                         | Pass    | `tests/phase2/calendar-rls.test.ts`                                                                                  |
| A2: entries can be added, edited, marked done, deleted, linked; app dates open own pages | Pass    | Driven in a real browser (throwaway spec, not committed); no UI tests by your rule                                   |
| A3: the exported file imports into Google Calendar                                       | **You** | I checked the file's structure and the links; importing it needs your Google account                                 |
| A4: a Google secret iCal address shows its events and refreshes on schedule              | **You** | Tested with a calendar served by a test server and an uploaded file; the real address and the n8n workflow are yours |
| A5: "What are my deadlines next week?" and "Move <entry> to Friday" with your model      | **You** | Everything around the model is tested; a run with a real model needs one                                             |

Tests added (five files in `tests/phase2/`, covering the plan's list): A-S1 (row-level security and the feed), A-S2 (the `.ics` file), A-S3 (the guarded fetch), A-S4 and A-C1 (the secret address and connectivity), A-S5 (parsing), A-S6 (the assistant). The suite has 2,556 tests; `npm run test:e2e` has 136.

## Decisions to know about

- **A new migration, 028, widens the AI task list.** So the contracts migration is now `029_contracts.sql` (the plan files say so).
- **A new dependency, `ical.js`** (MPL-2.0, no dependencies, no install scripts).
- **The guarded fetch is stricter than the plan:** port 443 only, no dotless or `.local` / `.internal` names.
- **No project name in the `.ics` description** (the feed's items don't carry one).
- **`08_calendar_sync.json` is not in `npm run n8n:go-live`,** which would stop for anyone who hasn't imported it. You import it by hand (below).
- Full list: `docs/DECISIONS.md`, the "A1" to "A5" entries.

## What hasn't been checked

- Anything that needs your accounts or a model: Google Calendar import of the `.ics`, "Add to Outlook" (Microsoft publishes no reference page for that link; its parameter names come from Microsoft Q&A threads), a real Google secret address, the n8n workflow running on a schedule, and a real model's answers.
- The month view and forms are plain and unpolished, as the plan asked. Source colours are saved but not yet drawn in the month view.
- A flaky test, now understood: `tests/invoice-pdf.test.ts` starts Chromium and can time out when the machine is busy (for example when `check` and `test:e2e` run together). Run them one at a time. Two other one-off failures in the whole suite on slow runs were not reproduced.

## What you need to do

Everything is in `docs/NEEDS_YOU.md`, at the top of "Open":

1. Import an exported `.ics` into Google Calendar and tell me how it looked, and try "Add to Outlook".
2. Copy a Google "Secret address in iCal format" into Calendar > Imported calendars.
3. In n8n, import `n8n/workflows/08_calendar_sync.json`, pick the `App internal API token` credential, and publish it.
4. Ask the assistant the two questions above with your model, and optionally pick a model for it in Settings > AI.
5. Apply the new migrations (`npm run db:migrate`) before running the app: 027 and 028.
