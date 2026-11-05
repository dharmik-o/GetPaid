# Design guide

The rules for the dashboard and landing page in `apps/web`. The look comes from the approved mock: `docs/design/redesign-brief.md` (the brief) and `docs/design/design-kit-reference.css` (its tokens and component styles). If they disagree with this file about the look, they win, apart from the fixes listed under Visual tokens. `docs/design/landing-copy.md` wins for every word on the landing page.

## Principles

- **Calm, not alarming:** freelancers open this when money is late. Use plain words, show the next step, and avoid red everywhere.
- **The next action first:** every screen leads with what needs the freelancer's attention (drafts to approve, overdue invoices).
- **Nothing hidden:** before anything is sent, show exactly what the client will see, including the PayPal link and the send time in both time zones.
- **Bold, but trustworthy:** the personality comes from the yellow, the heading font, the dotted triangles and the motion, not from clutter. Most of the UI is black, white and grey; yellow is the punctuation.

## Layout

- Left sidebar (240px, on `--bg`, with a `--line` divider): Home, Outbox (with a count badge), Clients, Projects, Retainers, Maintenance, Settings. The active item has a 3px yellow bar and `--text`; the rest are `--muted`.
- Header: the theme toggle, top right. On phones it also shows the logo.
- **Lists first:** a list page shows only the list. A primary button in the page header ("Add client", "New project", "Add retainer", "Add maintenance job") opens the create form on its own page, and Cancel goes back. While the list is empty, the button moves into the empty state, so there's only ever one.
- Content max width 1240px, with side padding of 40px on desktop and 20px on phones; one main column, with an optional right panel for details.
- Mobile (under 760px): the sidebar collapses to a bottom bar with Home, Outbox, Clients and More, not a top drawer. Approving a draft must work well on a phone. Touch targets are at least 44×44px.

## Screens

| Screen       | Route                                                 | What it shows                                                                                                                     |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Home         | `/`                                                   | Needs attention (drafts waiting, overdue invoices), recovery metrics, Upcoming list (next 90 days)                                |
| Landing page | `/welcome`                                            | Hero, How it works, Features, yellow statement band, final call to action, footer. Every call to action goes to `/`. No app shell |
| Outbox       | `/outbox`                                             | Filter tabs Waiting / Scheduled / Sent / Skipped; `OutboxCard` per draft                                                          |
| Clients      | `/clients`                                            | Table: name, country, open balance, last activity. **Add client** opens `/clients/new`                                            |
| Client       | `/clients/[id]`                                       | Header with totals; `Timeline` of messages, replies, payments, events                                                             |
| Projects     | `/projects`                                           | Table: project, client, deadline, total. **New project** opens `/projects/new`                                                    |
| New project  | `/projects/new`                                       | Step 1 details, step 2 schedule (`ScheduleForm`), step 3 optional milestones (`MilestoneEditor`)                                  |
| Project      | `/projects/[id]`                                      | Milestone list with status, invoice link, next reminder                                                                           |
| Retainers    | `/retainers`                                          | List of retainers. **Add retainer** opens `/retainers/new`: amount, interval, method (auto-pay / invoice)                         |
| Maintenance  | `/maintenance`                                        | Jobs and renewals with next due date, cost, lead time. **Add maintenance job** opens `/maintenance/new`                           |
| Settings     | `/settings`, `/settings/ai`, `/settings/integrations` | Schedule defaults; AI provider and test results; PayPal, Gmail and Telegram connections                                           |

## Components

- **OutboxCard:** client and amount; tier chip; send time ("Tue 10:00 client time, 20:30 yours"); full message preview; Approve (primary), Edit, Skip, Reschedule.
- **ScheduleForm:** grouped fields with the defaults shown, inline validation, and a live preview line ("First reminder: 18 Nov, then every 3 days").
- **MilestoneEditor:** rows with name, amount or %, deadline, mode; a running total that must equal the project total.
- **Timeline:** newest first; icons for sent, reply, payment, status change; an AI label on classified replies.
- **CurrencyNote:** one line under every currency dropdown, saying why INR isn't there. On the project form, Total and Currency share a row, so the note runs under the whole row.
- **UpcomingList:** grouped by week; each row shows the type (maintenance / renewal / retainer), client, date and amount.
- **StatusBadge:** the pill for a payment or milestone status. Takes the status, and always shows its label.
- **DottedTriangle:** the brand's decoration (see below).
- **Logo:** the yellow triangle and the name. The name lives in one constant, `BRAND_NAME` (`lib/brand.ts`).
- **ThemeToggle:** a 44px round button in the header, named "Switch to light mode" or "Switch to dark mode".

## Visual tokens

All of these live in `globals.css`, the project's one styling system. Dark is the default, on `:root`; light overrides it on `[data-theme="light"]`.

- **Dark:** `--bg` #000000, `--surface` #141414, `--surface-2` #1D1D1D, `--line` #2C2C2C, `--line-control` #686868, `--text` #FFFFFF, `--muted` #A8A8A8, `--accent-ink` #E8A800, `--dots` #E8A800, `--danger` #FF6B4A, `--focus` #E8A800, `--edge` transparent.
- **Light:** `--bg` #FFFFFF, `--surface` #F4F4F4, `--surface-2` #EBEBEB, `--line` #DDDDDD, `--line-control` #858585, `--text` #000000, `--muted` #565656, `--accent-ink` #875B00, `--dots` #D39700, `--danger` #B83A1C, `--focus` #875B00, `--edge` #000000.
- **Both:** `--accent` #E8A800, `--accent-hover` #FFC233, `--accent-press` #C98F00, `--on-accent` #000000.
- **Colour rules:** text on yellow is always black. Never put `--accent` text on white: use `--accent-ink`. No glows, neon or soft shadows. The dot pattern in the dotted triangle is the only gradient. The only other fixed colour is the white paper behind an invoice preview.
- **Themes:** a first visit follows the device's setting. The toggle's choice is saved in `localStorage` and used from then on. `next-themes` sets `data-theme` before the first paint, so there's no flash. The landing page and the app share the theme.
- **Fonts:** Clash Display (500, 600, 700, self-hosted in `public/fonts`) for headings, big numbers, the logo and stamps. Instrument Sans (400 to 700, from `@fontsource`) for everything else.
- **Type scale:** page title (`h1`) `clamp(28px, 3vw, 40px)`, section `h2` 28px, card title 22px, all Clash 600. Body 16px, line height 1.6. Small text 14px. Sentence case everywhere: no all-caps labels, no tracked-out eyebrows, and no yellow word in a headline.
- **Buttons:** pills, at least 48px tall. Primary is a solid `--accent` fill with black text and the `--edge` outline. On hover it lifts 2px on a hard offset shadow; on press it shrinks to 0.97. Secondary and the small `link-button` (14px radius, 44px tall) are transparent with a `--line-control` border. Danger has a `--danger` border and text. Disabled buttons use solid `--surface-2` and `--muted`, never a fade. Every state's text meets 4.5:1 in both themes.
- **Inputs:** at least 52px tall, 14px radius, `--surface-2` fill and a `--line-control` border, from one base rule in `globals.css`. On focus, an `--accent` border and a ring. On error, a `--danger` border and a message below saying what's wrong and how to fix it. The label sits above the field, never only as a placeholder.
- **Badges:** pills, 14px, weight 600 or 700, always with a text label. **Paid** is solid yellow with black text. **Sent, Pending, Waiting and Scheduled** are transparent with a `--line-control` border and `--muted` text. **Overdue** has a `--danger` border and text. **Draft** is `--surface-2` and `--muted`. A `chip` is the same as Sent, for facts rather than states (tier, type).
- **Borders:** cards, tables and dividers use `--line`. Everything you can press or type in uses `--line-control` or a colour of its own, at 3:1 or more against every surface. Yellow fills carry the `--edge` outline, which is black in light mode, because yellow on white is only 2:1.
- **Shape:** cards have a 16px radius and 24px padding, with no shadows. Landing panels have 28px. Cards in app lists change background on hover and nothing else.
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96, 120, 150. App pages use 24 to 40; landing sections use 120 to 150.
- **Money:** right-aligned, tabular numbers, always with the currency code (USD 1,500.00), never a symbol such as ₹.

## Dotted triangles

`<DottedTriangle />`: a triangle filled with a grid of dots, never solid colour, and always `aria-hidden`. App pages get at most one, small, at 0.25 to 0.4 opacity, in an empty corner or the empty state. The landing page gets one to three per section, mostly on the left and right edges and partly off-screen, never behind body text. Under 640px they shrink to about 60%. On the yellow band they use black dots (`variant="ink"`).

## Motion

- **App pages stay calm:** Motion only for button press, the Paid badge pop, list add and remove, and modal and page fades. No scroll effects.
- **Landing page:** GSAP and ScrollTrigger, there only: the hero timeline with the Paid stamp, triangle parallax, a scroll-filled "How it works" track, staggered feature panels, and a word-by-word yellow band.
- **Reduced motion:** with `prefers-reduced-motion`, content simply appears. Animate with `from()`, so everything is visible if JavaScript fails.

## States and accessibility

- Every list has an empty state that explains the next step ("No drafts waiting. Reminders appear here before they're sent.").
- Show loading skeletons, and errors that say what to do next.
- WCAG AA contrast, full keyboard access, visible focus (3px `--focus` outline, 3px offset), labels on every input; never use colour alone for status.

## Copy tone

Short and friendly. Say "Approve and send", not "Submit". Show dates as "18 Nov" with the time zone named.
