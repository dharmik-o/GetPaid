# Redesign brief: UI and UX only

This is a full visual redesign of a working payment tool for freelancers. The backend, routes, data and business logic are finished and must not change. Your job is presentation: layout, styling, typography, theming, motion and interaction feel.

---

## 0. Ground rules (read first)

1. **Do not touch** API calls, data fetching, server code, database code, auth logic, form field names, validation rules, route paths or state management. If a component mixes logic and markup, keep the logic exactly as it is and change only the JSX/HTML and styles around it.
2. **Inventory first.** Before you change anything, list every page/route and shared component in the project, and tell me which framework and styling setup it uses (React/Next/Vue/plain HTML; Tailwind/CSS modules/plain CSS). Then propose an order of work.
3. **Build the foundation first**, in this order: design tokens, fonts, theme switching, base components (buttons, inputs, cards, badges, nav), then the dotted-triangle decoration, then the motion utilities. Restyle pages only after that.
4. **One page at a time.** After each page, check that every flow still works (create invoice, send, pay, sign in, and so on) and that nothing broke in either theme.
5. Use the existing styling system if there is one (for example, map the tokens below into `tailwind.config` / CSS variables). Don't add a second styling system.
6. Keep it **simple**. This is a clean, confident website, not a busy one. The personality comes from the yellow, the heading font, the dotted triangles and the motion, not from clutter.

---

## 1. Brand feel

- Bold and confident, a little funky, but always trustworthy, because this handles people's money.
- **Dark mode (default):** pure black with a deep, vibrant marigold yellow.
- **Light mode:** pure white with the same yellow. Yellow *text* in light mode uses a darker ochre so it stays readable.
- The yellow is used with intent: primary buttons, the "Paid" state, key highlights, one full-bleed statement band on the landing page, and the dotted triangles. Most of the UI is black/white/grey; yellow is the punctuation.

---

## 2. Color tokens

Define these as CSS custom properties on `:root` (dark is the default), overridden on `[data-theme="light"]`.

### Dark theme (default)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#000000` | Page background |
| `--surface` | `#141414` | Cards, panels, modals |
| `--surface-2` | `#1D1D1D` | Inputs, nested panels, hover rows |
| `--line` | `#2C2C2C` | Borders, dividers |
| `--text` | `#FFFFFF` | Primary text |
| `--muted` | `#A8A8A8` | Secondary text (8.8:1 on black) |
| `--accent` | `#E8A800` | Marigold: buttons, highlights, Paid badge |
| `--accent-hover` | `#FFC233` | Hover on yellow fills |
| `--accent-press` | `#C98F00` | Pressed state on yellow fills |
| `--accent-ink` | `#E8A800` | Yellow used as text/icons |
| `--on-accent` | `#000000` | Text on yellow (10:1) |
| `--dots` | `#E8A800` | Dotted triangle dots |
| `--danger` | `#FF6B4A` | Errors, Overdue |
| `--focus` | `#E8A800` | Focus ring |

### Light theme

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FFFFFF` | Page background |
| `--surface` | `#F4F4F4` | Cards, panels |
| `--surface-2` | `#EBEBEB` | Inputs, nested panels, hover rows |
| `--line` | `#DDDDDD` | Borders |
| `--text` | `#000000` | Primary text |
| `--muted` | `#565656` | Secondary text (7.3:1 on white) |
| `--accent` | `#E8A800` | Same marigold for fills |
| `--accent-hover` | `#FFC233` | Hover on yellow fills |
| `--accent-press` | `#C98F00` | Pressed |
| `--accent-ink` | `#875B00` | Yellow *text*/icons on white (6:1). **Never put `#E8A800` text on white; it's only 2:1.** |
| `--on-accent` | `#000000` | Text on yellow |
| `--dots` | `#D39700` | Dotted triangle dots |
| `--danger` | `#B83A1C` | Errors, Overdue |
| `--focus` | `#875B00` | Focus ring |

**Rules**
- Text on yellow is always black, in both themes.
- No gradients, glows or neon. Flat colour only.
- Payment status badges: **Paid** = solid `--accent` fill + black text. **Pending/Sent** = transparent with a `--line` border and `--muted` text. **Overdue** = `--danger` border and text. **Draft** = `--surface-2` fill and `--muted` text.
- Use true black `#000000`, not `#0B0B0B` or `#111`.

---

## 3. Typography

| Role | Font | Source |
|---|---|---|
| Display: headings, big numbers, logo wordmark, stamps | **Clash Display** (500, 600, 700) | Fontshare (free), self-host the woff2 files |
| Body: paragraphs, UI, tables, forms, buttons | **Instrument Sans** (400, 500, 600, 700) | Google Fonts / `@fontsource/instrument-sans` |

- Download Clash Display from fontshare.com and self-host it (`/public/fonts`), with `font-display: swap`. If you need a quick start, the CDN works: `https://api.fontshare.com/v2/css?f[]=clash-display@500,600,700&display=swap`.
- Fallback stacks: `'Clash Display', 'Arial Black', system-ui, sans-serif` and `'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif`.
- Set `font-synthesis: none` on display text.
- **All money amounts use `font-variant-numeric: tabular-nums`** so columns line up.

### Type scale (use `clamp()` so it works on phones)

| Token | Size | Weight / line-height / tracking |
|---|---|---|
| `display-xl` (landing hero) | `clamp(48px, 7vw, 104px)` | Clash 700 / 1.0 / -0.03em |
| `display-l` (section headings) | `clamp(34px, 4.2vw, 60px)` | Clash 600 / 1.06 / -0.02em |
| `h1` (app page titles) | `clamp(28px, 3vw, 40px)` | Clash 600 / 1.1 / -0.015em |
| `h2` | `28px` | Clash 600 / 1.15 |
| `h3` (card titles) | `22px` | Clash 600 / 1.2 |
| `amount-xl` (balances, invoice totals) | `clamp(36px, 4vw, 56px)` | Clash 600 / 1 / tabular-nums |
| `body-l` | `19px` | Instrument 400 / 1.55 |
| `body` | `16px` | Instrument 400 / 1.6 |
| `small` | `14px` | Instrument 500 / 1.45 |
| `button` | `16px` (lg: 18px) | Instrument 600 |

**Rules**
- Sentence case everywhere ("Create invoice", not "CREATE INVOICE"). No all-caps labels, no tiny tracked-out "eyebrow" labels above headings.
- Keep paragraph lines under about 70 characters (`max-width: 36em`).
- Don't colour one word of a headline yellow. Headlines are `--text`; yellow shows up in buttons, the statement band, the stamp and the triangles.

---

## 4. Layout, spacing, shape

- Content container: `max-width: 1240px`, side padding `40px` desktop, `20px` mobile.
- Spacing scale (px): 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96, 120, 150. Landing sections use 120–150 vertical padding; app pages use 24–40.
- Radius: buttons and badges `999px` (pills); inputs and small buttons `14px`; app cards `16px`; landing feature panels `28px`; invoice card `22px`.
- Borders are 1px `--line`. No drop shadows on cards; separation comes from `--surface` against `--bg` plus the border. The only "shadow" is the hard offset on the primary button hover (see 6).
- Avoid a grid of identical cards. On the landing page, feature panels come in mixed widths (for example 3:2 then 2:3 using `flex: 3 1 560px` / `flex: 2 1 360px`).
- Mobile-first responsive: everything stacks under 760px, tables scroll horizontally inside a box, nav collapses into a menu.
- Touch targets are at least 44×44px.

---

## 5. Signature decoration: dotted triangles

This is the brand's recognisable detail. Triangles are **not filled with solid colour; they're filled with a grid of dots.**

Build one reusable component, `<DottedTriangle />`:

```css
.dotted-triangle {
  position: absolute;
  pointer-events: none;
  z-index: 0;
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
  background-image: radial-gradient(circle, var(--dots) 1.7px, transparent 2.1px);
  background-size: 13px 13px;
}
```

Props: `size` (width; height ≈ 0.9 × width), `rotate` (deg), `opacity` (0.4–0.9), position (`top/left/right/bottom`), `parallax` (bool), `variant` ("accent" uses `--dots`; "ink" uses black dots, for use on the yellow band). Always `aria-hidden="true"`.

**Placement rules**
- Mostly on the **left and right edges**, partly off-screen (for example `right: -90px`), so they frame content without sitting on top of it. Never behind body text where they'd hurt readability; content sits at `z-index: 2`.
- Mix sizes: one large (300–380px), one medium (200–260px), one small (80–120px) per section at most. Vary the rotations (-30° to 200°), and avoid making them symmetrical.
- Landing page: 1–3 per section. App pages (dashboard etc.): at most one, small and low-opacity (0.25–0.4), in an empty corner or the empty state.
- On screens under 640px, show at most one per section and scale them to about 60%.
- On the yellow statement band, use the "ink" variant (black dots).
- Motion: slow parallax on scroll (section 6).

Optional secondary detail, used sparingly: a dotted vertical line (`border-left: 2px dotted var(--accent)`) for timelines such as the reminder schedule and invoice history.

---

## 6. Motion system

### Libraries
- **GSAP + ScrollTrigger** (`gsap`; in React also `@gsap/react` with `useGSAP` for automatic cleanup): page-load timelines and everything driven by scrolling.
- **Motion** (`motion` package, `import { motion } from "motion/react"`; this is the library formerly called Framer Motion): component interactions such as buttons, toggles, modals, dropdowns, list add/remove, tabs and page transitions.
- If the project isn't React, use GSAP for everything, and Motion's vanilla `animate()` for small interactions.
- Register plugins once (`gsap.registerPlugin(ScrollTrigger)`), scope selectors to a container ref, and clean up on unmount (`useGSAP` or `gsap.context().revert()`).

### Intensity: Expressive
The marketing pages get the full treatment. **App pages (dashboard, invoices, settings) stay calm**: quick, functional transitions only, with no scroll gimmicks, because people use them every day.

### Global timing tokens
| Token | Value |
|---|---|
| Fast (hover, press) | 0.15–0.2s |
| Base (UI enter/exit) | 0.3s |
| Reveal (scroll-in) | 0.7–0.9s |
| Ease, enter | `power3.out` (GSAP) / `[0.22, 1, 0.36, 1]` (Motion) |
| Ease, exit | `power2.in` |
| Spring (Motion) | `{ type: "spring", stiffness: 420, damping: 28 }` |
| Stagger | 0.08–0.12s |

### Accessibility, required
- Wrap all GSAP motion in `gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`. In Motion, use `useReducedMotion()` or `<MotionConfig reducedMotion="user">`. With reduced motion on, content just appears with no movement.
- Animate with `from()`, so if JS fails the content is still visible in its final state.
- Animate only `transform` and `opacity` (plus `scaleX` for progress lines). Never animate layout properties.

### Landing page moments
1. **Hero load timeline** (the one big moment):
   - Headline lines rise up from inside a mask (`overflow: hidden` wrapper per line, `yPercent: 115 → 0`, stagger 0.1, 0.95s).
   - The subtext and CTAs fade up (y 18 → 0).
   - An **example invoice card** slides in tilted (y 80, rotation 6° → -2.5°), then its line items stagger in.
   - Its status pill changes from "Sent" to "Paid" (crossfade plus a springy `back.out(3)` scale).
   - A circular **"Paid" stamp** slams down onto the card (from scale 2.8, rotation -50°, opacity 0, `power4.in`, 0.45s), and the card does a tiny 7px bounce on impact.
2. **Dotted triangles parallax:** each triangle moves `yPercent: ±28` and rotates `±16°` across its section's scroll range (`scrub: true`). Alternate direction per triangle.
3. **Section headings reveal:** y 36 → 0 and fade in, triggered at `top 85%`, once.
4. **"How it works" (4 steps):** a horizontal track line behind the step circles fills with yellow from left to right as you scroll (`scaleX: 0 → 1`, `transform-origin: left`, `scrub: 0.6`). Each step's circle fills yellow in turn as the line reaches it. On mobile the line is hidden and the steps simply stagger in.
5. **Feature panels** stagger up (y 60, stagger 0.12) when the section enters. Small items inside them (such as the reminder timeline rows) stagger in slightly after.
6. **Yellow statement band:** a full-width `--accent` section with one big Clash Display sentence in black. Each word is its own span, and words go from opacity 0.16 to 1 in reading order as you scroll through (`scrub: true`). This is the scroll moment people should remember.
7. Optional: smooth scrolling with Lenis, landing page only. Skip it if it causes any issues.

### Button and interaction animations (Motion)
- **Primary button** (yellow pill, black text):
  - Hover: `y: -2`, background `--accent-hover`, plus a hard offset shadow `box-shadow: 0 6px 0 0 var(--text)` so it looks like it lifts off a black base (0.2s).
  - Press: `scale: 0.97`, `y: 0`, shadow shrinks to `0 2px 0 0`, background `--accent-press`.
  - Loading: the label crossfades to three bouncing dots, and the button keeps its width.
  - Success (for example after "Send invoice"): the label morphs to a check icon whose stroke draws in, then to the past-tense label ("Sent"). Keep the verb consistent: "Send invoice", then "Sent".
- **Secondary button:** transparent with a 1px `--line` border; on hover the border becomes `--text` and the background `--surface-2`.
- **Text links:** the underline is a 2px `--accent` line that grows from left to right on hover (`scaleX`).
- **Copy-link button:** on click the label swaps to "Copied" with a small spring pop, then reverts after 2s.
- **Theme toggle:** the sun/moon icon rotates 90° and crossfades. Colours transition on `html` with `transition: background-color .45s, color .45s` (disable during the very first paint).
- **Cards in app lists:** hover changes the background to `--surface-2` (0.15s) and nothing else. No lift, no scale.
- **Modals/drawers:** fade the backdrop in (0.2s); the panel slides up 24px with the spring. Exit is faster (0.18s).
- **Lists (invoices, clients):** new rows animate in with `layout` and height/opacity; removed rows collapse. Use `AnimatePresence`.
- **Status change to Paid** anywhere in the app: the badge pops (`scale 0.6 → 1`, spring) and fills yellow. This mirrors the hero stamp and is the app's small reward moment.
- **Page transitions (app):** fade only, with the content shifting 8px (0.25s). Never block navigation on an animation.

---

## 7. Theme switching

- Use `data-theme="dark" | "light"` on `<html>`. Dark is the default.
- On first visit, follow `prefers-color-scheme`. After the user toggles, save the choice in `localStorage` and use it from then on.
- Set the attribute in a tiny inline script in `<head>` **before first paint** to avoid a flash of the wrong theme (in Next.js, `next-themes` does this).
- The toggle sits in the top nav as a 44px round icon button, with `aria-label="Switch to light mode"` / `"Switch to dark mode"`.

---

## 8. Components (restyle what already exists)

- **Nav (marketing):** logo (a small solid yellow triangle plus the wordmark in Clash Display 700), links in Instrument 500, the theme toggle, and a yellow "Get started" pill. Transparent over the hero; once you scroll past 40px, it becomes `--bg` at 85% opacity with `backdrop-filter: blur(12px)` and a bottom `--line`.
- **App shell:** a left sidebar (240px) on `--bg` with a `--line` divider. The active item has a 3px yellow bar on its left plus `--text` colour, and inactive items are `--muted`. On mobile it collapses to a top bar with a drawer.
- **Inputs:** 52px tall, `--surface-2` background, 1px `--line` border, 14px radius. Focus: border `--accent` plus a 3px focus ring. The label sits above the field, never only as a placeholder. Error: `--danger` border plus a message below saying what's wrong and how to fix it.
- **Badges:** see the status rules in section 2. Pill-shaped, 14px text, weight 600–700.
- **Tables (invoices, payments):** no zebra stripes; rows are separated by `--line`. Money is right-aligned in tabular numbers. The row hover is `--surface-2`.
- **Invoice / payment page (what the client sees):** keep it the cleanest page of all. White or black card, the freelancer's logo, line items, a big total in `amount-xl`, and one big yellow "Pay ₹X" button. One small dotted triangle in a corner at most. This page must feel safe.
- **Empty states:** a small dotted triangle, one plain sentence, and the main action button (for example "No invoices yet. Create your first one.").
- **Focus states everywhere:** `outline: 3px solid var(--focus); outline-offset: 3px`.

---

## 9. Landing page structure (if the site has one)

1. Nav
2. **Hero:** headline on the left (for example "You did the work. Now get paid for it.", or the existing headline), short subtext, primary CTA plus a secondary underlined link; on the right, the animated example invoice with the Paid stamp. Large dotted triangles bleed off the right edge, with a smaller one bottom-left.
3. **How it works:** 4 numbered steps with the scroll-filled track line. Numbering is fine here because it's a real sequence.
4. **Features:** mixed-width panels, each with a small live UI snippet (a payment link field with a Copy button, a reminder timeline, colour swatches for branding, a mini list of client statuses) instead of icons.
5. **Yellow statement band:** a word-by-word scroll fill.
6. **Final CTA:** centred headline plus a primary button, with triangles at the sides.
7. **Footer:** a quiet footer with `--line` on top, logo, a few links and ©.

Use the site's existing copy and real features. Don't invent stats, testimonials or logos; if a section needs them and they don't exist, leave it out or ask me.

---

## 10. Don'ts

- No gradients, glassmorphism cards, neon glows or emoji in the UI.
- No all-caps eyebrow labels, and no "→" stuck onto the end of every button.
- No grids of identical rounded cards with soft grey shadows.
- No fade-up on every single element. Motion is for the moments listed above.
- No yellow text on white (use `--accent-ink`).
- Don't change any behaviour, data or routes.

---

## 11. Done checklist

- [ ] Every page restyled in both themes, with no unstyled leftovers
- [ ] Theme persists, with no flash on reload
- [ ] All flows still work end to end
- [ ] Contrast: body text ≥ 4.5:1, large text ≥ 3:1 in both themes
- [ ] Keyboard: every control reachable with a visible focus ring
- [ ] `prefers-reduced-motion` turns off movement
- [ ] Works at 375px, 768px, 1280px and 1440px
- [ ] Lighthouse performance not worse than before; fonts are self-hosted and preloaded
