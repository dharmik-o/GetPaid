# Design guide

The rules for the dashboard and landing page in `apps/web`. The look comes from the approved mock: `docs/design/redesign-brief.md` (the brief) and `docs/design/design-kit-reference.css` (its tokens and component styles), restyled as "Calm Kinetic" (R2, approved 10 Nov 2026) from the four Stitch screens in `docs/design/stitch/`. If they disagree with this file about the look, they win, apart from the fixes listed under Visual tokens. The screens' sample wording is not ours: every word and number in the UI is the app's own. `docs/design/landing-copy.md` wins for every word on the landing page.

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
- Mobile (under 760px): the sidebar collapses to a floating pill bar with Home, Outbox, Clients and More, not a top drawer. Each has an icon, and the page you're on is a yellow circle behind its icon (with the `--edge` outline in light mode). More opens a small menu above the bar with Projects, Retainers, Maintenance and Settings. Approving a draft must work well on a phone. Touch targets are at least 44×44px.

## Screens

| Screen       | Route                                                 | What it shows                                                                                                                                                        |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home         | `/`                                                   | Needs attention (drafts waiting, overdue invoices), recovery metrics, Upcoming list (next 90 days)                                                                   |
| Landing page | `/welcome`                                            | Hero, How it works, Features, yellow statement band, final call to action, footer. Every call to action goes to `/`. No app shell                                    |
| Outbox       | `/outbox`                                             | Filter tabs Waiting / Scheduled / Sent / Skipped; `OutboxCard` per draft                                                                                             |
| Clients      | `/clients`                                            | Table: name, country, open balance, last activity. **Add client** opens `/clients/new`                                                                               |
| Client       | `/clients/[id]`                                       | Tabs: Overview (header with totals; `Timeline` of messages, replies, payments, events) and Invoices (by project, with total sent and paid per currency, and filters) |
| Projects     | `/projects`                                           | Table: project, client, deadline, total. **New project** opens `/projects/new`                                                                                       |
| New project  | `/projects/new`                                       | Step 1 details, step 2 schedule (`ScheduleForm`), step 3 optional milestones (`MilestoneEditor`)                                                                     |
| Project      | `/projects/[id]`                                      | A strip of Invoiced, Paid and Outstanding, then a status card per milestone (invoice, progress, next reminder, actions); Invoices (every invoice and saved version, with filters) |
| Retainers    | `/retainers`                                          | List of retainers. **Add retainer** opens `/retainers/new`: amount, interval, method (auto-pay / invoice)                                                            |
| Maintenance  | `/maintenance`                                        | Jobs and renewals with next due date, cost, lead time. **Add maintenance job** opens `/maintenance/new`                                                              |
| Settings     | `/settings`, `/settings/ai`, `/settings/integrations` | Schedule defaults; AI provider and test results; PayPal, Gmail and Telegram connections                                                                              |

## Components

- **OutboxCard:** client and amount; send time ("Tue 10:00 client time, 20:30 yours"); the email in an inset box: a header row with the subject (muted, left) and the tier as a primary-colour chip ("Friendly reminder · Tier 1", right), the message at 16px/1.6 with the invoice number and amount in bold primary (in the preview only: the email itself is unchanged), and the pay link as an inset card (a 40px "P" tile, "PayPal pay link", "Invoice <number> · <currency> <amount>", and the real link's domain with an external-link icon); then Approve and send (primary, with an envelope icon), Edit, Skip, Reschedule as pills.
- **ScheduleForm:** grouped fields with the defaults shown, inline validation, and a live preview line ("First reminder: 18 Nov, then every 3 days").
- **MilestoneEditor:** rows with name, amount or %, deadline, mode; a running total that must equal the project total.
- **Timeline:** newest first, on a dotted vertical spine in the brand yellow. Each entry has a ring node (12px ring, 4px dot), a kind chip (Email: `--secondary` fill; Client reply: plain outline; Payment: yellow; Update: neutral), a bold title and its time on the right in muted. A reply the AI has read gets a nested panel: a sparkle icon and "AI suggestion: <label>" in the brand colour, then the client's words in italic as plain text (untrusted). The card header has "Timeline" and a small "Activity log" meta label.
- **Milestone card:** on the Project page, two to a row on a desktop and one on a phone. The name, the invoice number and terms in muted ("FPR-000008 · due 4 Nov"), the amount in Clash with tabular numbers, a StatusBadge, a progress bar of paid against the amount, the next reminder, the invoice's links and a copy button, and its actions. A StatusStamp sits in the top-right corner when the milestone is paid, part paid or overdue. The summary strip above uses the same card look. A retainer's billed cycles are ledger rows.
- **StatusStamp:** a rectangle turned -8°, with a 2px dashed border and Clash caps text: PAID (yellow), PART PAID (a lighter yellow in dark mode; in light mode the next ochre step, as lighter fails 3:1) or OVERDUE (`--danger`). It is `aria-hidden`: the badge beside it carries the meaning. The round GetPaid stamp stays the logo and the landing page's moment.
- **Progress:** a thin 8px rounded bar, `--accent` on `--surface-2`. The fill has the `--edge` outline, so it shows on white. It is a `progressbar` with a label and a value.
- **Icon:** the app's few inline stroked icons (envelope, pencil, ban, external link, sparkle, home, send, user, more, file). Decorative and `aria-hidden`: the label beside one says what it is.
- **Ledger rows:** the Home "Days late per invoice" list and a retainer's cycles: the name on the left with its invoice number and terms in muted under it; on the right the amount (bold, tabular) with its state under it (Paid muted, open in the brand colour, overdue in `--danger`). A list ends with a total row when its amounts share a currency: a small caps label on the left, a big yellow Clash amount on the right (Client > Invoices). The invoice log (Project and Client Invoices) stays a table with every column, as it's the record.
- **CurrencyNote:** one line under every currency dropdown, saying why INR isn't there. On the project form, Total and Currency share a row, so the note runs under the whole row.
- **UpcomingList:** grouped by week; each row shows the type (maintenance / renewal / retainer), client, date and amount.
- **StatusBadge:** the pill for a payment or milestone status. Takes the status, and always shows its label.
- **AnimatedList:** wraps a list of cards, so a new one opens up and a removed one collapses. Nothing moves on page load.
- **PaidMoment and PaidBadge:** the Paid stamp on a row, and the badge that pops with it (see The Paid stamp).
- **MoreMenu:** the phone's More button and its small menu.
- **DottedTriangle:** the brand's decoration (see below).
- **Logo:** the GetPaid stamp (`public/getpaid-stamp.svg`) and the name, replacing the mock's yellow triangle. The stamp is gold in dark mode and `--accent-ink` ochre in light, through `--logo-ink`. It's also the browser tab's icon. The name lives in one constant, `BRAND_NAME` (`lib/brand.ts`), but the stamp's lettering is part of the drawing, so a rename also needs a new stamp.
- **Tour (`TourProvider`, `TourCard`):** the guided tour and page tips (`docs/CHANGE-onboarding-tour.md`). The page dims with a cut-out round one real element (`data-tour="..."`), edged by a 2px `--accent` ring at 12px radius. The card is an app card (20px radius, `--shadow-pop`): a muted "3 of 9" counter and a quiet "Skip tour" on top, a Clash 22px title, one sentence, then Back (secondary pill) and "Got it" (primary pill; "Finish" on the last step). It sits beside the target, flipped to stay on screen; on phones it is a bottom sheet (along the top when the target is low on the screen). With no target it is centred. Focus moves into the card; Esc skips; reduced motion removes the slide.
- **ProjectDangerZone:** the last card of a project page, headed "Danger zone": Archive (or Restore) with one line on what it does, then Delete, which opens an inline confirm. The confirm lists what is still open in PayPal, asks for a tick ("Cancel them in PayPal too") when something is, and enables its `button-danger` only when the project's name has been typed exactly.
- **RecordPayment, CancelInvoice, CompleteProject:** inline forms that open in place of their button (an `editor-form`, no dialog): fields, then a Review step that says exactly what will happen, then Confirm. The destructive confirm is a `button-danger`. Each shows the server's error in a `banner-error` and never closes on failure.
- **HelpPanel and HelpAnswerView:** a 44px round Help button (question-mark icon) beside the theme toggle in the header, which opens a right-hand side panel (440px, `--surface`, `--shadow-pop`, a dimmed backdrop; a full-width sheet on phones). It has a heading, a Close link, three suggestion chips, a question box (500 characters at most), Ask, and an `aria-live` area for the answer: the answer as plain text, a muted "From the manual: ..." line, the allowed links, and a small "Download the manual (PDF)" link. Focus moves to the question box on open; Esc and the backdrop close it and return focus to the button.
- **ThemeToggle:** a 44px round button in the header, named "Switch to light mode" or "Switch to dark mode".

## Visual tokens

All of these live in `globals.css`, the project's one styling system. Dark is the default, on `:root`; light overrides it on `[data-theme="light"]`.

- **Dark:** `--bg` #000000, `--surface` #161616, `--surface-2` #1D1D1D, `--line` #2C2C2C, `--line-control` #686868, `--text` #FFFFFF, `--muted` #A8A8A8, `--accent-ink` #E8A800, `--dots` #E8A800, `--danger` #FF6B4A, `--focus` #E8A800, `--edge` transparent.
- **Light:** `--bg` #F5F4F0 (warm off-white page), `--surface` #FFFFFF (cards), `--surface-2` #F0EFEA (inputs, nested panels, hover rows), `--line` #E4E2DB (hairline; shadows do the separating), `--line-control` #858585, `--text` #000000, `--muted` #565656, `--accent-ink` #875B00, `--dots` #D39700, `--danger` #B83A1C, `--focus` #875B00, `--edge` #000000.
- **Both:** `--accent` #E8A800, `--accent-hover` #FFC233, `--accent-press` #C98F00, `--on-accent` #000000, `--secondary` #875B00 (ochre) and `--on-secondary` #FFFFFF. Ochre is yellow-as-text in light mode (`--accent-ink`) and the fill of secondary chips and tiles.
- **Palette (Calm Kinetic):** Primary #E8A800 (hover #FFC233, press #C98F00), Secondary #875B00, Tertiary #FF6B4A (the dark `--danger`; #B83A1C as text in light mode), Neutral #141414.
- **Ramps:** ten tonal steps for each of the four, `--primary-50` to `--primary-900`, and the same for `--secondary-*`, `--tertiary-*` and `--neutral-*`. 50 is nearly white and 900 nearly black; 500 is the colour itself (neutral: 900 is #141414). A new style takes its tint from a ramp step rather than a new hex. Colours that carry text (`--accent-ink`, `--danger`, `--muted`) stay plain hex in the theme blocks, because tests measure their contrast.
- **Colour rules:** text on yellow is always black. Never put `--accent` text on white: use `--accent-ink`. No glows or neon. Soft shadows follow the Depth rules below. The dot pattern in the dotted triangle is the only gradient. The only other fixed colour is the white paper behind an invoice preview.
- **Themes:** a first visit follows the device's setting. The toggle's choice is saved in `localStorage` and used from then on. `next-themes` sets `data-theme` before the first paint, so there's no flash. The landing page and the app share the theme.
- **Fonts:** Clash Display (500, 600, 700, self-hosted in `public/fonts`) for headings, big numbers, the logo and stamps. Instrument Sans (400 to 700, from `@fontsource`) for everything else.
- **Meta labels:** a small tag such as "Activity log", or a ledger total's caption ("Total sent"), may be 12px, uppercase, with 0.08em tracking, in `--muted` or the brand colour (`.meta-label`). Never for headings, buttons, sentences or anything a person must read at length.
- **Type scale:** landing hero `clamp(48px, 7vw, 104px)` Clash 700, line height 1.0, -0.03em; landing section headings `clamp(34px, 4.2vw, 60px)` Clash 600, 1.06, -0.02em; page title (`h1`) `clamp(28px, 3vw, 40px)` Clash 600, 1.1, -0.015em; `h2` 28px; card title 22px, Clash 600; big amounts (`amount-xl`: balances, totals) `clamp(36px, 4vw, 56px)` Clash 600 with tabular numbers. Body 16px, line height 1.6; large body 19px, 1.55; small text 14px, weight 500; buttons 16px (large 18px), weight 600.
- **Font details:** fallback stacks `'Clash Display', 'Arial Black', system-ui, sans-serif` and `'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif`. `font-synthesis: none` on display text. Paragraphs stay under about 70 characters (`max-width: 36em`). Fonts are self-hosted and preloaded, with `font-display: swap`. Sentence case everywhere, apart from the meta labels above and the stamps: no all-caps headings or eyebrows, and no yellow word in a headline.
- **Buttons:** pills, at least 48px tall. Primary is a solid `--accent` fill with black text and the `--edge` outline, with an optional leading icon (an envelope on "Approve and send"). A destructive button is an outline pill in `--danger` with a ban icon. **Inverted** (`button-inverted`) is a light fill with dark text in dark mode and the reverse in light mode; the small outlined button is `link-button`. On hover it lifts 2px on a hard offset shadow; on press it shrinks to 0.97. Secondary and the small `link-button` (14px radius, 44px tall) are transparent with a `--line-control` border. Danger has a `--danger` border and text. Disabled buttons use solid `--surface-2` and `--muted`, never a fade. Every state's text meets 4.5:1 in both themes.
- **Inputs:** at least 52px tall, 14px radius, `--surface-2` fill and a `--line-control` border, from one base rule in `globals.css`. On focus, an `--accent` border and a ring. On error, a `--danger` border and a message below saying what's wrong and how to fix it. The label sits above the field, never only as a placeholder.
- **Checkbox and radio:** drawn by `globals.css` on the real input (`appearance: none`), 24px. A checkbox is a rounded square: a hairline when off, a yellow fill with a black tick when on. A radio is a ring: a hairline when off, a yellow ring with a yellow dot when on. The label sits beside it, aligned to its first line, with any hint under the text.
- **Badges:** 28px pills, 14px, weight 600 or 700, always with a text label. **Paid** is solid yellow with black text. **Part paid** has a yellow outline and yellow text (`--accent-ink`). **Sent, Pending, Waiting and Scheduled** are transparent with a `--line-control` border and `--muted` text. **Overdue** has a `--danger` border and text, with the day count ("Overdue 8d") where the app knows it. **Draft** is `--surface-2` and `--muted`. A `chip` is the same as Sent, for facts rather than states (tier, type).
- **Borders:** cards, tables and dividers use `--line`. Everything you can press or type in uses `--line-control` or a colour of its own, at 3:1 or more against every surface. Yellow fills carry the `--edge` outline, which is black in light mode, because yellow on white is only 2:1.
- **Shape:** radius 999px (pills) for buttons and badges; 14px for inputs and small buttons; 20px for app cards (28px padding on a desktop, 24px on a phone); 22px for the invoice card; 28px for landing feature panels.
- **Depth (light mode):** white cards on the off-white page, lifted by soft layered shadows:
  - `--shadow-card`: `0 1px 2px rgba(20,18,10,.06), 0 2px 6px rgba(20,18,10,.05), 0 8px 24px -6px rgba(20,18,10,.10)`. Every card, table container, metric tile, Outbox card and form panel.
  - `--shadow-card-hover`: `0 1px 2px rgba(20,18,10,.07), 0 6px 14px rgba(20,18,10,.08), 0 16px 32px -8px rgba(20,18,10,.14)`. Only cards you can click (Outbox cards, list rows that open a page): the shadow changes in 0.15s, with no lift or scale.
  - `--shadow-panel`: `0 1px 0 rgba(20,18,10,.06), 0 4px 16px rgba(20,18,10,.06)`. The sidebar, the mobile bottom bar and sticky headers.
  - `--shadow-control`: `inset 0 1px 2px rgba(20,18,10,.06)`. Inputs, selects and textareas look slightly recessed.
  - `--shadow-button`: `0 1px 2px rgba(20,18,10,.08)`. Secondary buttons.
  - `--shadow-pop`: `0 4px 8px rgba(20,18,10,.08), 0 24px 48px -12px rgba(20,18,10,.22)`. Menus, dropdowns, dialogs and toasts.
  - The primary yellow button keeps only its hard offset hover shadow (`0 6px 0 0 var(--text)`), never a soft one.
- **Depth (dark mode):** shadows barely show on black, so cards stand out by being lighter than the page. `--shadow-card` and `--shadow-panel` are `inset 0 1px 0 rgba(255,255,255,.04)`, `--shadow-card-hover` is `inset 0 1px 0 rgba(255,255,255,.06)`, `--shadow-control` and `--shadow-button` are none, and `--shadow-pop` is `0 0 0 1px #2c2c2c, 0 24px 48px rgba(0,0,0,.6)`.
- **Tables:** no zebra stripes; rows are split by `--line`; money is right-aligned in tabular numbers; row hover is `--surface-2`. On phones, tables with `table-stack` become labelled rows (each cell has a `data-label`), so an amount never hides behind a scroll. Tables with six or more columns (`stack-wide`: milestones, invoice history) do the same below 1200px.
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96, 120, 150. App pages use 24 to 40; landing sections use 120 to 150.
- **Money:** right-aligned, tabular numbers, always with the currency code (USD 1,500.00), never a symbol such as ₹.

## Dotted triangles

`<DottedTriangle />`: a triangle filled with a grid of dots, never solid colour, and always `aria-hidden`. App pages get at most one, small, at 0.25 to 0.4 opacity: in the corner of an empty card if the page has one, and otherwise in the sidebar's corner. CSS gives an empty card its triangle, so it needs no markup. The landing page gets one to three per section, mostly on the left and right edges and partly off-screen, never behind body text. Under 640px they shrink to about 60%. On the yellow band they use black dots (`variant="ink"`).

Props: `size` (width; height is about 0.9 × width), `rotate`, `opacity` (0.4 to 0.9 on the landing page), position (`top`, `left`, `right`, `bottom`), `parallax`, and `variant` (`accent` uses `--dots`, `ink` uses black). Per landing section, mix at most one large (300–380px), one medium (200–260px) and one small (80–120px), with rotations between -30° and 200°, never symmetrical. Content sits above them at `z-index: 2`.

A dotted vertical line (`border-left: 2px dotted var(--accent)`) is the secondary detail, for timelines only: the reminder schedule, the client timeline and invoice history.

## Motion

- **App pages stay calm:** Motion only for button press, the Paid badge pop, list add and remove, and modal and page fades. No scroll effects.
- **Landing page:** GSAP and ScrollTrigger, there only: the hero timeline with the Paid stamp, triangle parallax, a scroll-filled "How it works" track, staggered feature panels, and a word-by-word yellow band.
- **Reduced motion:** with `prefers-reduced-motion`, content simply appears. Animate with `from()`, so everything is visible if JavaScript fails. Wrap GSAP in `gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`; in Motion use `useReducedMotion()`, as `<MotionConfig reducedMotion="user">` would still fade opacity. Animate only `transform` and `opacity` (plus `scaleX` for progress lines), never layout properties.

### Timing

| Token                      | Value                                               |
| -------------------------- | --------------------------------------------------- |
| Fast (hover, press)        | 0.15–0.2s                                           |
| Base (UI enter and exit)   | 0.3s                                                |
| Reveal (landing scroll-in) | 0.7–0.9s                                            |
| Ease, enter                | `power3.out` (GSAP) / `[0.22, 1, 0.36, 1]` (Motion) |
| Ease, exit                 | `power2.in`                                         |
| Spring (Motion)            | `{ type: "spring", stiffness: 420, damping: 28 }`   |
| Stagger                    | 0.08–0.12s                                          |

### Interactions

- **Primary button:** hover lifts 2px onto `--accent-hover` with the hard offset shadow (0.2s); press shrinks to 0.97 on `--accent-press` with the shadow at `0 2px 0 0`. While loading, the label crossfades to three bouncing dots and the button keeps its width. On success, a check draws itself in, then the past-tense label shows, with the verb kept consistent ("Approve and send", then "Sent").
- **Secondary button:** on hover the border becomes `--text` and the fill `--surface-2`.
- **Text links:** a 2px `--accent` underline grows from left to right on hover.
- **Copy buttons:** the label swaps to "Copied" with a small spring pop, then reverts after 2s.
- **Theme toggle:** the sun or moon icon rotates 90° and crossfades. Colours ease on `html` over 0.45s, never on the very first paint.
- **Dialogs and menus:** the backdrop fades in over 0.2s and the panel slides up 24px on the spring; closing is faster (0.18s).
- **Lists:** new rows animate in, and removed rows collapse (`AnimatePresence` with `layout`).
- **Page changes in the app:** a fade with an 8px shift, 0.25s. Never block navigation on an animation.

### The Paid stamp

The GetPaid stamp (`public/getpaid-stamp.svg`) is the reward moment.

- **In the app:** when an invoice, installment or captured hold turns Paid, the stamp (72px, `--accent-ink`, through the existing mask) drops once onto that row or card: from scale 2.8, rotation -50° and opacity 0, to scale 1 and rotation -14°, in 0.45s with an ease-in. The row bounces 4px, and the Paid badge pops from scale 0.6 to 1 on the spring. It plays on the Project page, the client timeline and Home's "Days late per invoice" table, once per paid item per browser (seen IDs in `localStorage`, wrapped in try/catch). Screen readers hear it through `aria-live` ("FPR-000042 paid"). The stamp has `pointer-events: none` and never blocks a click.
- **On the landing page:** the hero's example invoice flips its pill from Sent to Paid (crossfade plus a `back.out(3)` scale), then the stamp slams down (from scale 2.8, rotation -50°, opacity 0, `power4.in`, 0.45s) and the card bounces 7px.

### Landing page moments

1. **Hero:** headline lines rise from inside a mask (`yPercent` 115 to 0, stagger 0.1, 0.95s); the subtext and buttons fade up (y 18 to 0); the example invoice slides in tilted (y 80, rotation 6° to -2.5°), its rows stagger in, then the Paid stamp moment above.
2. **Triangles:** each moves `yPercent` ±28 and rotates ±16° across its section's scroll (`scrub: true`), alternating direction.
3. **Section headings:** y 36 to 0 with a fade, at `top 85%`, once.
4. **How it works:** a track line behind the four step circles fills with yellow as you scroll (`scaleX` 0 to 1, from the left, `scrub: 0.6`), and each circle fills as the line reaches it. On phones the line is hidden and the steps simply stagger in.
5. **Features:** panels stagger up (y 60, stagger 0.12); small items inside them follow slightly after.
6. **Yellow band:** each word is its own span and goes from opacity 0.16 to 1 in reading order as you scroll through (`scrub: true`).
7. No Lenis smooth scrolling.

## Landing page

- Route `/welcome`, with no app shell. Words come from `docs/design/landing-copy.md`.
- **Nav:** the logo, links (How it works, Features), the theme toggle and an "Open dashboard" pill. Transparent over the hero; after 40px of scrolling it becomes `--bg` at 85% opacity with `backdrop-filter: blur(12px)` and a `--line` bottom border.
- **Sections:** hero (headline left, animated invoice right, large triangles off the right edge and a smaller one bottom-left), How it works, Features, the yellow statement band, the final call to action, and a quiet footer.
- **Feature panels** come in mixed widths (3:2, then 2:3, with `flex: 3 1 560px` and `flex: 2 1 360px`), each with a small live snippet instead of an icon. Never a grid of identical cards.
- Landing sections use 120–150px of vertical padding. Everything stacks under 760px.

## States and accessibility

- Every list has an empty state: a small dotted triangle, one plain sentence that explains the next step, and the page's main button ("No drafts waiting. Reminders appear here before they're sent.").
- Show loading skeletons, and errors that say what to do next.
- WCAG AA contrast, full keyboard access, visible focus (3px `--focus` outline, 3px offset), labels on every input; never use colour alone for status.

## Copy tone

Short and friendly. Say "Approve and send", not "Submit". Show dates as "18 Nov" with the time zone named.

## Don'ts

- No gradients (apart from the triangles' dots), glassmorphism cards, neon glows or emoji in the UI. The landing nav's blur is the one exception.
- No all-caps eyebrow labels (the meta labels above are the one allowed kind), and no "→" stuck onto the end of every button.
- No grids of identical rounded cards.
- No fade-up on every element: motion is only for the moments listed above.
- No yellow text on white: use `--accent-ink`.
- Redesign work never changes behaviour, data, routes, form field names, validation or email content.
- Never copy a mock's sample wording ("click-tracking", "verified settlement link", "Tone: …", a double space after a currency code). Use the app's real data and labels.

## Done checklist (for any visual change)

- Every page styled in both themes, with no unstyled leftovers.
- The theme persists, with no flash on reload.
- Every flow still works end to end, and `npm run check` and `npm run test:e2e` are green.
- Contrast: body text at least 4.5:1, large text 3:1, controls and focus rings 3:1, in both themes, on `--bg` and on `--surface`.
- Every control is reachable by keyboard, with a visible focus ring.
- `prefers-reduced-motion` turns movement off.
- Works at 375px, 768px, 1280px and 1440px.
- Lighthouse performance is no worse than before; fonts are self-hosted and preloaded.
