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
- Mobile (under 760px): the sidebar collapses to a bottom bar with Home, Outbox, Clients and More, not a top drawer. More opens a small menu above the bar with Projects, Retainers, Maintenance and Settings. Approving a draft must work well on a phone. Touch targets are at least 44×44px.

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
- **Logo:** the GetPaid stamp (`public/getpaid-stamp.svg`) and the name, replacing the mock's yellow triangle. The stamp is gold in dark mode and `--accent-ink` ochre in light, through `--logo-ink`. It's also the browser tab's icon. The name lives in one constant, `BRAND_NAME` (`lib/brand.ts`), but the stamp's lettering is part of the drawing, so a rename also needs a new stamp.
- **ThemeToggle:** a 44px round button in the header, named "Switch to light mode" or "Switch to dark mode".

## Visual tokens

All of these live in `globals.css`, the project's one styling system. Dark is the default, on `:root`; light overrides it on `[data-theme="light"]`.

- **Dark:** `--bg` #000000, `--surface` #141414, `--surface-2` #1D1D1D, `--line` #2C2C2C, `--line-control` #686868, `--text` #FFFFFF, `--muted` #A8A8A8, `--accent-ink` #E8A800, `--dots` #E8A800, `--danger` #FF6B4A, `--focus` #E8A800, `--edge` transparent.
- **Light:** `--bg` #F5F4F0 (warm off-white page), `--surface` #FFFFFF (cards), `--surface-2` #F0EFEA (inputs, nested panels, hover rows), `--line` #E4E2DB (hairline; shadows do the separating), `--line-control` #858585, `--text` #000000, `--muted` #565656, `--accent-ink` #875B00, `--dots` #D39700, `--danger` #B83A1C, `--focus` #875B00, `--edge` #000000.
- **Both:** `--accent` #E8A800, `--accent-hover` #FFC233, `--accent-press` #C98F00, `--on-accent` #000000.
- **Colour rules:** text on yellow is always black. Never put `--accent` text on white: use `--accent-ink`. No glows or neon. Soft shadows follow the Depth rules below. The dot pattern in the dotted triangle is the only gradient. The only other fixed colour is the white paper behind an invoice preview.
- **Themes:** a first visit follows the device's setting. The toggle's choice is saved in `localStorage` and used from then on. `next-themes` sets `data-theme` before the first paint, so there's no flash. The landing page and the app share the theme.
- **Fonts:** Clash Display (500, 600, 700, self-hosted in `public/fonts`) for headings, big numbers, the logo and stamps. Instrument Sans (400 to 700, from `@fontsource`) for everything else.
- **Type scale:** landing hero `clamp(48px, 7vw, 104px)` Clash 700, line height 1.0, -0.03em; landing section headings `clamp(34px, 4.2vw, 60px)` Clash 600, 1.06, -0.02em; page title (`h1`) `clamp(28px, 3vw, 40px)` Clash 600, 1.1, -0.015em; `h2` 28px; card title 22px, Clash 600; big amounts (`amount-xl`: balances, totals) `clamp(36px, 4vw, 56px)` Clash 600 with tabular numbers. Body 16px, line height 1.6; large body 19px, 1.55; small text 14px, weight 500; buttons 16px (large 18px), weight 600.
- **Font details:** fallback stacks `'Clash Display', 'Arial Black', system-ui, sans-serif` and `'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif`. `font-synthesis: none` on display text. Paragraphs stay under about 70 characters (`max-width: 36em`). Fonts are self-hosted and preloaded, with `font-display: swap`. Sentence case everywhere: no all-caps labels, no tracked-out eyebrows, and no yellow word in a headline.
- **Buttons:** pills, at least 48px tall. Primary is a solid `--accent` fill with black text and the `--edge` outline. On hover it lifts 2px on a hard offset shadow; on press it shrinks to 0.97. Secondary and the small `link-button` (14px radius, 44px tall) are transparent with a `--line-control` border. Danger has a `--danger` border and text. Disabled buttons use solid `--surface-2` and `--muted`, never a fade. Every state's text meets 4.5:1 in both themes.
- **Inputs:** at least 52px tall, 14px radius, `--surface-2` fill and a `--line-control` border, from one base rule in `globals.css`. On focus, an `--accent` border and a ring. On error, a `--danger` border and a message below saying what's wrong and how to fix it. The label sits above the field, never only as a placeholder.
- **Badges:** pills, 14px, weight 600 or 700, always with a text label. **Paid** is solid yellow with black text. **Sent, Pending, Waiting and Scheduled** are transparent with a `--line-control` border and `--muted` text. **Overdue** has a `--danger` border and text. **Draft** is `--surface-2` and `--muted`. A `chip` is the same as Sent, for facts rather than states (tier, type).
- **Borders:** cards, tables and dividers use `--line`. Everything you can press or type in uses `--line-control` or a colour of its own, at 3:1 or more against every surface. Yellow fills carry the `--edge` outline, which is black in light mode, because yellow on white is only 2:1.
- **Shape:** radius 999px (pills) for buttons and badges; 14px for inputs and small buttons; 16px for app cards (24px padding); 22px for the invoice card; 28px for landing feature panels.
- **Depth (light mode):** white cards on the off-white page, lifted by soft layered shadows:
  - `--shadow-card`: `0 1px 2px rgba(20,18,10,.06), 0 2px 6px rgba(20,18,10,.05), 0 8px 24px -6px rgba(20,18,10,.10)`. Every card, table container, metric tile, Outbox card and form panel.
  - `--shadow-card-hover`: `0 1px 2px rgba(20,18,10,.07), 0 6px 14px rgba(20,18,10,.08), 0 16px 32px -8px rgba(20,18,10,.14)`. Only cards you can click (Outbox cards, list rows that open a page): the shadow changes in 0.15s, with no lift or scale.
  - `--shadow-panel`: `0 1px 0 rgba(20,18,10,.06), 0 4px 16px rgba(20,18,10,.06)`. The sidebar, the mobile bottom bar and sticky headers.
  - `--shadow-control`: `inset 0 1px 2px rgba(20,18,10,.06)`. Inputs, selects and textareas look slightly recessed.
  - `--shadow-button`: `0 1px 2px rgba(20,18,10,.08)`. Secondary buttons.
  - `--shadow-pop`: `0 4px 8px rgba(20,18,10,.08), 0 24px 48px -12px rgba(20,18,10,.22)`. Menus, dropdowns, dialogs and toasts.
  - The primary yellow button keeps only its hard offset hover shadow (`0 6px 0 0 var(--text)`), never a soft one.
- **Depth (dark mode):** shadows barely show on black, so cards stand out by being lighter than the page. `--shadow-card` and `--shadow-panel` are `inset 0 1px 0 rgba(255,255,255,.04)`, `--shadow-card-hover` is `inset 0 1px 0 rgba(255,255,255,.06)`, `--shadow-control` and `--shadow-button` are none, and `--shadow-pop` is `0 0 0 1px #2c2c2c, 0 24px 48px rgba(0,0,0,.6)`.
- **Tables:** no zebra stripes; rows are split by `--line`; money is right-aligned in tabular numbers; row hover is `--surface-2`. On phones, a wide table scrolls inside its own box or becomes cards.
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96, 120, 150. App pages use 24 to 40; landing sections use 120 to 150.
- **Money:** right-aligned, tabular numbers, always with the currency code (USD 1,500.00), never a symbol such as ₹.

## Dotted triangles

`<DottedTriangle />`: a triangle filled with a grid of dots, never solid colour, and always `aria-hidden`. App pages get at most one, small, at 0.25 to 0.4 opacity, in an empty corner or the empty state. The landing page gets one to three per section, mostly on the left and right edges and partly off-screen, never behind body text. Under 640px they shrink to about 60%. On the yellow band they use black dots (`variant="ink"`).

Props: `size` (width; height is about 0.9 × width), `rotate`, `opacity` (0.4 to 0.9 on the landing page), position (`top`, `left`, `right`, `bottom`), `parallax`, and `variant` (`accent` uses `--dots`, `ink` uses black). Per landing section, mix at most one large (300–380px), one medium (200–260px) and one small (80–120px), with rotations between -30° and 200°, never symmetrical. Content sits above them at `z-index: 2`.

A dotted vertical line (`border-left: 2px dotted var(--accent)`) is the secondary detail, for timelines only: the reminder schedule, the client timeline and invoice history.

## Motion

- **App pages stay calm:** Motion only for button press, the Paid badge pop, list add and remove, and modal and page fades. No scroll effects.
- **Landing page:** GSAP and ScrollTrigger, there only: the hero timeline with the Paid stamp, triangle parallax, a scroll-filled "How it works" track, staggered feature panels, and a word-by-word yellow band.
- **Reduced motion:** with `prefers-reduced-motion`, content simply appears. Animate with `from()`, so everything is visible if JavaScript fails. Wrap GSAP in `gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`; in Motion use `useReducedMotion()`, as `<MotionConfig reducedMotion="user">` would still fade opacity. Animate only `transform` and `opacity` (plus `scaleX` for progress lines), never layout properties.

### Timing

| Token | Value |
| --- | --- |
| Fast (hover, press) | 0.15–0.2s |
| Base (UI enter and exit) | 0.3s |
| Reveal (landing scroll-in) | 0.7–0.9s |
| Ease, enter | `power3.out` (GSAP) / `[0.22, 1, 0.36, 1]` (Motion) |
| Ease, exit | `power2.in` |
| Spring (Motion) | `{ type: "spring", stiffness: 420, damping: 28 }` |
| Stagger | 0.08–0.12s |

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
- No all-caps eyebrow labels, and no "→" stuck onto the end of every button.
- No grids of identical rounded cards.
- No fade-up on every element: motion is only for the moments listed above.
- No yellow text on white: use `--accent-ink`.
- Redesign work never changes behaviour, data, routes, form field names or validation.

## Done checklist (for any visual change)

- Every page styled in both themes, with no unstyled leftovers.
- The theme persists, with no flash on reload.
- Every flow still works end to end, and `npm run check` and `npm run test:e2e` are green.
- Contrast: body text at least 4.5:1, large text 3:1, controls and focus rings 3:1, in both themes, on `--bg` and on `--surface`.
- Every control is reachable by keyboard, with a visible focus ring.
- `prefers-reduced-motion` turns movement off.
- Works at 375px, 768px, 1280px and 1440px.
- Lighthouse performance is no worse than before; fonts are self-hosted and preloaded.
