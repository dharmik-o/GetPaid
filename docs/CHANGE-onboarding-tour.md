# T1: guided tour of the dashboard

**Status:** in the plan as milestone T1 (`docs/FEATURES.md`). Planned by the owner on 5 Nov 2026, updated and requested on 11 Nov 2026.

## Goal

A first-time freelancer opening the dashboard gets a short, skippable walkthrough. Each step highlights one real part of the screen with one plain sentence, until the tour is finished. Pages with a lot on them also give a short tip the first time they are opened.

## Controls

- The main button says **Got it** (the last step says **Finish**). Also **Back**, **Skip tour** and a step counter ("3 of 9"). Esc skips.
- Page tips use the same card and buttons; their skip button says **Skip tips**.

## The main tour (first login, crosses pages)

Each step highlights one real element, found by a `data-tour="..."` attribute. Each text is one sentence, under 20 words, in the tone of `docs/DESIGN.md`, and claims nothing the feature doesn't do. The words live in `lib/tour-steps.ts`.

1. Home: the "Needs attention" card
2. Sidebar: Clients
3. Projects: New project
4. A project: milestone cards and the PAID / OVERDUE stamps
5. Outbox: a draft card (approve, edit, skip, reschedule)
6. Calendar
7. Settings > Integrations (Telegram, Gmail, PayPal)
8. Settings > AI
9. Done: "Replay this tour any time from Settings."

## Page tips (first visit to that page, 2 to 4 steps, a separate "seen" flag per page)

- **Project page:** summary, milestone card, Agreement card, Lawyer pack (the payment record download).
- **Calendar:** click a day, imported calendars, the assistant.
- **Agreement builder:** options, preview, Send for signature. (The builder has no step bar and no "Ask AI to add terms", so the tip doesn't mention them.)
- **Client page:** the timeline (rows expand), the AI suggestion (it only suggests).

Tips show only after the main tour has been finished or skipped, and not on the page where the main tour has just ended.

## The component

A small custom component, no new dependency (the app already has `motion`): a dimmed page with a cut-out round the target, a 2px primary ring with 12px radius, and a card in the app's card style (Clash Display title, body text, pill buttons) beside the target, flipped to stay on screen. On phones it is a bottom sheet (along the top when the target is in the lower part of the screen, such as the phone's bottom bar) and the target is scrolled into view. The tour moves between pages with the router, never a reload. A step whose target isn't on the page shows centred.

## Saving progress

Three columns on the user's own `users` row (migration 032): `tour_completed_at`, `tour_skipped_at`, `tour_tips_seen`. The existing row-level security covers them. `GET/POST /api/tour` validates its input with zod. Nothing is kept only in `localStorage`. Settings has **Replay tour** and **Reset page tips**.

## Where it never shows

`/welcome`, `/sign/*`, the demo login page (the app shell is not rendered there), and any visitor whose progress can't be loaded (signed out). In demo mode (`DEMO_MODE`) a correct demo password resets the demo user's progress, so every new demo session sees the tour.

## Accessibility

Focus moves into the card on every step and goes back to where it was when the tour ends; keyboard only works (Tab stays inside the card, Esc skips); the card is `role="dialog"` with `aria-labelledby`; each step is announced through an `aria-live` region; with reduced motion nothing moves (the page isn't scrolled smoothly and the card doesn't slide).

## Done when

- A new user sees the tour once, can finish or skip it, and it doesn't return unless replayed.
- Every step works on desktop and phone widths.
- The progress route rejects bad input, and another user can't read or write someone else's progress (RLS).
- One Playwright test: step 1 on a new user, "Got it" through all 9 across pages, reload shows no tour; Replay from Settings restarts it; Skip on step 2 ends it; a page tip shows on the first Calendar visit and not the second.
