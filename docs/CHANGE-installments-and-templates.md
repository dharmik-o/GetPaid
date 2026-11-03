# Change: installments instead of partial payments, and custom invoice templates

**Status:** approved by the user on 3 Nov 2026. Claude Code: fold this into `docs/MVP-spec.md` and `docs/FEATURES.md` (see "Where it goes"), log it in `docs/DECISIONS.md`, then build it. This file wins over older spec text about partial payments.

## Part 1: Installments replace partial payments

### Why

PayPal's partial payments aren't offered in every country (the sandbox refused them: "Partial payments are not available in your country"), and the launch markets may not have them either. Installments are separate PayPal invoices with fixed amounts and their own due dates. They need no special PayPal feature, so they work everywhere. They also give each payment its own reminders, its own paid status, and a clear line on the invoice: "Installment 2 of 3".

### Rules

- **No PayPal partial payments at all.** Remove `allow_partial_payment`, `partial_payment` and `minimum_amount_due` from every PayPal call. `invoices.minimum_due_cents` is no longer used (drop it in a new migration).
- **An installment plan** splits one milestone (or a single-invoice project's 100% milestone) into 2 to 12 installments. Each installment has an amount and a due date. Amounts are integer cents and must add up exactly to the milestone amount; if they're split evenly, the last installment absorbs the rounding remainder (same rule as milestone percentages).
- **One PayPal invoice per installment**, created and sent the same way as today (invoice number guard, no PayPal emails). Each one has its own reminder schedule, worked out from its own due date.
- **When installments are created:**
  - **At setup:** the freelancer picks "Pay in installments" on a milestone and sets the split.
  - **Deposit:** the old deposit mode becomes "installment 1 due at kickoff". The freelancer sets its amount (required, more than 0 and less than the milestone amount); the rest is installment 2 (or more), due when the milestone is delivered.
  - **When a client asks to pay in parts:** the reply listener sorts the reply as an installment request and drafts a split (e.g. 2 × $750, due today and on the 15th) for the freelancer to approve. On approval, the open invoice is cancelled and the installment invoices are created. Nothing changes without approval (security rules 4 and 5). An invoice that already has money on it is never cancelled; only the unpaid remainder can be split.
- **What the invoice says** (PayPal invoice `detail.note`, plus the item description):
  - "Installment 2 of 3 for Website redesign: Build"
  - "Milestone total USD 1,500.00 · Paid so far USD 500.00 · This installment USD 500.00 · Remaining after this USD 500.00"
  - The due dates of the other installments.
- **Statuses:** a milestone with installments is Partially paid while some are paid, and Paid when all are. Installment invoices use the existing invoice statuses.
- **Reminders and tiers** run per installment. A reminder for installment 2 never mentions installment 3 as overdue unless it is.

### Data model (new migration)

- `invoices`: add `installment_number` (1 to 12), `installment_count` and `installment_plan_id` (all null for a plain invoice). Check that number ≤ count.
- Replace the unique index `invoices_one_open_per_milestone` with one open invoice per (milestone, installment number).
- New table `installment_plans`: `user_id`, `milestone_id`, `count`, `created_from` (setup / deposit / client_request), `status` (active / completed / cancelled), with RLS like every other table.

### Demo changes (spec steps 2, 5 and 6)

- Step 2: the $900 Design milestone is set up as a deposit (installment 1 of 1 due at kickoff). Pay it; the milestone becomes Paid.
- Step 5: the client asks "Can I pay half now and half on the 15th?". The AI drafts a 2-installment split of the $1,500 Build milestone; the presenter approves it in Telegram.
- Step 6: pay installment 1 ($750) in the sandbox. The milestone shows Partially paid (1 of 2), and the next reminder is for installment 2, due on the 15th.

## Part 2: Invoice templates

### What freelancers get

- **Three built-in templates:** Classic (clean, formal), Modern (bold header, accent colour) and Minimal (plain, lots of white space). Each one shows the freelancer's name and logo, client details, line items, totals, installment line, payment terms and the PayPal pay link.
- **Custom templates:** the freelancer writes their own HTML and CSS, using tags that the app fills in.
- **A live preview** with sample data, and a "Set as default" option (per account, overridable per client).

### Where the template is used

PayPal's own invoice page can't use custom HTML; it only takes a logo and PayPal's built-in layout. So the template produces **the freelancer's own invoice document**, as a PDF:

- Attached to the PayPal invoice, if the Invoicing API allows attachments in the sandbox (check the API reference first).
- Attached to the reminder emails sent from the freelancer's Gmail (always).
- Downloadable from the dashboard.

The PayPal pay link inside the PDF is the same link used everywhere else.

### Tags

Logic-less placeholders in double braces. Unknown tags are an error shown in the editor, not a blank.

| Group | Tags |
| --- | --- |
| Freelancer | `{{freelancer.name}}`, `{{freelancer.business_name}}`, `{{freelancer.email}}`, `{{freelancer.address}}`, `{{freelancer.logo}}` |
| Client | `{{client.name}}`, `{{client.company}}`, `{{client.email}}`, `{{client.address}}` |
| Invoice | `{{invoice.number}}`, `{{invoice.issue_date}}`, `{{invoice.due_date}}`, `{{invoice.title}}`, `{{invoice.pay_link}}`, `{{invoice.terms}}`, `{{invoice.late_fee_clause}}` |
| Line items | `{{#items}} … {{/items}}` repeating `{{name}}`, `{{description}}`, `{{quantity}}`, `{{unit_price}}`, `{{amount}}`; also `{{expense_1}}`, `{{expense_2}}` … as shortcuts for the first rows |
| Totals | `{{totals.subtotal}}`, `{{totals.tax}}`, `{{totals.discount}}`, `{{totals.total}}`, `{{currency}}` |
| Installments | `{{installment.number}}`, `{{installment.count}}`, `{{installment.paid_so_far}}`, `{{installment.remaining}}`, `{{#installment.schedule}} … {{/installment.schedule}}` |
| AI-written text | `{{greeting}}`, `{{thank_you_note}}`, `{{project_summary}}`, `{{notes}}` |

### What the AI fills, and what it never fills

- **AI fills only the text tags:** greeting, thank-you note, project summary and notes. It writes them from the project, milestone and client context, through the AI router, and the result must match a schema (`prompts/schemas/invoice-text.schema.json`). The freelancer sees and can edit the text before the invoice is created.
- **Everything else comes from the database, never the AI:** names, amounts, dates, invoice numbers, installment figures and the pay link. Money is formatted by the one money formatter. If AI text mentions an amount or date, it's rejected and regenerated (or the freelancer writes it).

### Security (custom HTML is untrusted input)

- **Sanitise on save:** strip `<script>`, event handlers (`on*=`), `<iframe>`, `<object>`, `<embed>`, forms, `javascript:` URLs and `@import`. Allow only a known set of tags and CSS properties.
- **No outside resources:** no remote images, fonts or stylesheets. Images (like the logo) come from the app as embedded data. This keeps the PDF the same every time and stops a template from leaking data to another server.
- **Escape every tag value** when filling the template (logic-less engine such as Mustache, with HTML escaping on).
- **Render in isolation:** the preview is a sandboxed iframe with no scripts. The PDF is made by headless Chromium (already installed for the Playwright tests) with JavaScript disabled and network access off.
- **Size limit:** HTML plus CSS up to 100 KB per template.

### Data model (new migration)

- New table `invoice_templates`: `user_id`, `name`, `kind` (builtin / custom), `html`, `css`, `is_default`, `created_at`, `updated_at`, with RLS. Built-ins are seeded rows that users can copy but not edit.
- `invoices`: add `template_id` and `pdf_path`. `clients`: add `default_template_id` (optional).

### Screens (follow `docs/DESIGN.md`)

- **Settings > Invoice templates:** the three built-ins and the user's custom ones; Preview, Duplicate, Set as default.
- **Template editor:** HTML and CSS boxes side by side with a live preview, a tag list to click and insert, and the sanitiser's errors shown inline.
- **Create invoice:** pick a template, see the AI-written text with Edit, then Create.

## Where it goes

| Part | Milestone | Why there |
| --- | --- | --- |
| Installments | **M3, now:** rework the open "Invoices" item | It unblocks M3; the sandbox can't do partial payments |
| Installment requests from client replies | M7 (reply listener) | That's where replies are sorted |
| Templates and PDF | New item at the end of **M5** ("Invoice templates") | It needs the AI router (M4) for the AI text |

## Tests to add

- Installments: even and uneven splits, remainder on the last installment, totals must match exactly, max 12, a paid invoice can't be split, cancelling the open invoice and creating installments in one approved step, statuses Partially paid then Paid, reminders per installment.
- PayPal mock: no request ever contains `partial_payment` or `allow_partial_payment`.
- Templates: every tag fills, unknown tag errors, values are HTML-escaped, the sanitiser removes scripts, event handlers and remote URLs, a template with a remote image is refused, PDF rendering runs with network off, AI text with an amount or date in it is rejected.
