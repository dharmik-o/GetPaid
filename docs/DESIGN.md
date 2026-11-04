# Design guide

Starter design rules for the dashboard in `apps/web`. If you make mockups later (Figma or Claude Design), put the exports in `docs/design/` and link them here; the mockups then win over this file.

## Principles

- **Calm, not alarming:** freelancers open this when money is late. Use plain words, show the next step, and avoid red everywhere.
- **The next action first:** every screen leads with what needs the freelancer's attention (drafts to approve, overdue invoices).
- **Nothing hidden:** before anything is sent, show exactly what the client will see, including the PayPal link and the send time in both time zones.

## Layout

- Left sidebar: Home, Outbox (with a count badge), Clients, Projects, Retainers, Maintenance, Settings.
- **Lists first:** a list page shows only the list. A primary button in the page header ("Add client", "New project", "Add retainer", "Add maintenance job") opens the create form on its own page, and Cancel goes back. While the list is empty, the button moves into the empty state, so there's only ever one.
- Content max width 1100px; one main column, with an optional right panel for details.
- Mobile: the sidebar collapses to a bottom bar with Home, Outbox, Clients and More. Approving a draft must work well on a phone.

## Screens

| Screen | Route | What it shows |
| --- | --- | --- |
| Home | `/` | Needs attention (drafts waiting, overdue invoices), recovery metrics, Upcoming list (next 90 days) |
| Outbox | `/outbox` | Filter tabs Waiting / Scheduled / Sent / Skipped; `OutboxCard` per draft |
| Clients | `/clients` | Table: name, country, open balance, last activity. **Add client** opens `/clients/new` |
| Client | `/clients/[id]` | Header with totals; `Timeline` of messages, replies, payments, events |
| Projects | `/projects` | Table: project, client, deadline, total. **New project** opens `/projects/new` |
| New project | `/projects/new` | Step 1 details, step 2 schedule (`ScheduleForm`), step 3 optional milestones (`MilestoneEditor`) |
| Project | `/projects/[id]` | Milestone list with status, invoice link, next reminder |
| Retainers | `/retainers` | List of retainers. **Add retainer** opens `/retainers/new`: amount, interval, method (auto-pay / invoice) |
| Maintenance | `/maintenance` | Jobs and renewals with next due date, cost, lead time. **Add maintenance job** opens `/maintenance/new` |
| Settings | `/settings`, `/settings/ai`, `/settings/integrations` | Schedule defaults; AI provider and test results; PayPal, Gmail and Telegram connections |

## Components

- **OutboxCard:** client and amount; tier chip; send time ("Tue 10:00 client time, 20:30 yours"); full message preview; Approve (primary), Edit, Skip, Reschedule.
- **ScheduleForm:** grouped fields with the defaults shown, inline validation, and a live preview line ("First reminder: 18 Nov, then every 3 days").
- **MilestoneEditor:** rows with name, amount or %, deadline, mode; a running total that must equal the project total.
- **Timeline:** newest first; icons for sent, reply, payment, status change; an AI label on classified replies.
- **UpcomingList:** grouped by week; each row shows the type (maintenance / renewal / retainer), client, date and amount.

## Visual tokens

- **Font:** Inter (or the system UI font); sizes 14 body, 16 section, 20 page title.
- **Colours:** neutral greys plus one accent (teal). Status: green = paid, amber = due soon or partially paid, red = overdue (used sparingly, only on the badge).
- **Spacing:** 4px steps; cards 16px padding, 8px radius, 1px border, no heavy shadows.
- **Money:** right-aligned, tabular numbers, always with the currency code (USD 1,500.00).

## States and accessibility

- Every list has an empty state that explains the next step ("No drafts waiting. Reminders appear here before they're sent.").
- Show loading skeletons, and errors that say what to do next.
- WCAG AA contrast, full keyboard access, visible focus, labels on every input; never use colour alone for status.

## Copy tone

Short and friendly. Say "Approve and send", not "Submit". Show dates as "18 Nov" with the time zone named.
