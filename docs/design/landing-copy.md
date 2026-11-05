# Landing page: copy and content

Use this copy for the landing page. Take the layout, animation and look from the mock and `redesign-brief.md` (sections 5, 6 and 9), but **not** its words: the mock's text describes a generic invoicing app (payment links, rupee amounts, "Sign in"), and none of that exists here.

## Where it lives

- Route: **`/welcome`**. The dashboard stays at `/`.
- Every call to action goes to the dashboard (`/`). There's no sign-up or sign-in yet, so no link says "Sign in" or "Sign up".
- The product name is **GetPaid**. Keep it in one constant, `BRAND_NAME`, shared with the app shell and the page title, so it's a one-line change later.

## Rules for all landing copy

- Only real features. No stats, testimonials, customer logos, prices or "trusted by".
- Money always has a currency code, never ₹: `USD 1,500.00`, `EUR 800.00`, `GBP 2,000.00`.
- Sentence case. Short sentences. The tone is calm and confident, because this handles money.

---

## 1. Nav

- Logo: the GetPaid stamp plus `GetPaid`
- Links: **How it works** (`#how`), **Features** (`#features`)
- Theme toggle
- Primary pill: **Open dashboard** (→ `/`)

## 2. Hero

- **Headline (4 masked lines):** You did / the work. / Now get / paid for it.
- **Subtext:** AI drafts your payment reminders, you approve them from Telegram, and every email carries a PayPal pay link. Polite first, firmer later, and never sent without you.
- **Primary button:** Open dashboard (→ `/`)
- **Secondary link:** See how it works (→ `#how`)
- **Example invoice card** (animated as in the mock: slides in, rows stagger, Sent → Paid, the stamp slams down):
  - Top: `FPR-000042` (muted), **Northwind Studio**
  - Rows: Website design, milestone 2 · `USD 1,200.00`; Extra revisions, 3 hours · `USD 300.00`
  - Total: `USD 1,500.00`
  - Bottom strip: Paid through PayPal
  - Stamp: **Paid** (no "in 2 days" or other claim)

## 3. How it works (`#how`)

- **Heading:** Set the rules once. After that, it's one tap.
- **Subtext:** Your reminders run on a schedule you choose, in your client's time zone, from your own Gmail.
- **Steps** (with the scroll-filled track line):
  1. **Set the rules.** Deadline, payment terms, milestones, and how firm reminders get.
  2. **AI drafts the reminder.** On schedule, in your client's working hours, with the PayPal link built in.
  3. **You approve it.** Tap Approve, Edit or Skip on Telegram, or in the Outbox.
  4. **You get paid.** PayPal tells the app the moment it's paid, and the reminders stop by themselves.

## 4. Features (`#features`)

**Heading:** Built around how freelancers actually get paid.

Mixed-width panels (3:2, then 2:3), each with a small live snippet instead of an icon:

**Panel A (wide): Reminders that escalate, politely**

- Text: Courtesy first, then firmer. The final notice cites only your contract's late-fee clause, and it never invents a law or a fee.
- Snippet, a dotted-line timeline:
  - **Before the due date:** a friendly heads-up
  - **Day 1 late:** a polite reminder with the pay link up front
  - **Day 8:** a clear, firmer nudge
  - **Day 22:** a final notice, and only if you approve it

**Panel B (narrow): Approve from your phone**

- Text: Every draft waits for you. One tap on Telegram, and it goes out on your own Gmail thread.
- Snippet, a Telegram-style card:
  - Tier 1 · Northwind Studio · `USD 1,500.00`
  - Sends Tue 10:00 their time (20:30 yours)
  - Buttons: **Approve** (yellow) · Edit · Skip

**Panel C (narrow): Replies, read for you**

- Text: When a client writes back, reminders pause until you decide. The AI reads the reply and suggests the next step. It can't change anything by itself.
- Snippet:
  - Client: "Can I pay this in two parts?"
  - Suggestion: **Installments**. Split the remaining `USD 1,500.00` into 2.
  - Buttons: **Split into 2** · Resume reminders

**Panel D (wide): Every way you bill**

- Text: Deposits, milestones, installments, retainers with auto-pay, maintenance and renewal reminders, and milestone holds that secure the money before you start.
- Snippet, a mini client list with status badges:
  - Northwind Studio · `USD 1,500.00` · **Paid** (yellow)
  - Pixel and Pine · `EUR 800.00` · Scheduled
  - Kite Coffee Co. · `GBP 450.00` · Overdue

Optional fifth panel, if it fits the rhythm: **Your AI, your choice.** Run a local model so client emails never leave your computer, or connect Claude, OpenAI or Gemini. Snippet: three small pills, _Local (Ollama)_ · _Claude_ · _OpenAI_.

## 5. Yellow statement band

Words fill in one by one as you scroll:

> Less time chasing clients for money. More time doing the work they hired you for.

## 6. Final call to action

- **Heading:** Set up your first reminder schedule.
- **Subtext:** It runs on your own Gmail, Telegram and PayPal accounts, and nothing is ever sent without your approval.
- **Button:** Open dashboard (→ `/`)

## 7. Footer

- The GetPaid stamp plus `GetPaid`
- Links: How it works · Features · Dashboard
- `© 2026 GetPaid`
- No Privacy or Terms links until those pages exist.
