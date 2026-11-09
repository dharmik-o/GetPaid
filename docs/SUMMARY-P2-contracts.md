# Phase 2 summary: contracts and legal tools (C1 to C5)

Everything in Part C is built and merged into `main`, with `npm run check` and `npm run test:e2e` green at every step (the suite has 2,673 tests; `test:e2e` has 136). Each step was built, checked and merged one after another in solo mode; the records are in `docs/qa/C1.md` to `C5.md` and on the board, `docs/qa/STATUS.md`.

**Read this first: nothing legal is switched on yet.** The app never writes law and cites only an entry you have approved. I could not read the official pages for any of the seven laws from here (several sites refused or answered empty), so `legal/statutes.json` is empty, and every rate in `legal/reference-rates.json` is unapproved. Until you fill and approve them, a final demand cites only your own contract's clause and calculates no interest. That's the safe default, and it is covered by tests.

## What was built

| Step   | What you get                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | The facts the laws need: a client's state or province and "this client is a business", and in Settings your legal name, Udyam number and governing-law country (migration 029). Laws now carry `approved`, `appliesWhen`, interest and compensation rules; a law is cited only when approved and every condition holds for the stored facts. `legal/reference-rates.json` (Bank of England and ECB from official sources, all unapproved) and `npm run legal:check`.                     |
| **C2** | The agreement builder at `/projects/[id]/agreement`: fixed clause text with your options (deposit, revisions, acceptance, cancellation fee, late-payment wording, governing law, confidentiality, portfolio), a live preview, drafts, void and new versions. Once sent, the database itself refuses any change to the document (migration 030).                                                                                                                                          |
| **C3** | "Send for signature": the document is frozen, a one-use link is made (only its hash is stored), and an Outbox email carries it, so nothing reaches the client without your approval. The public `/sign/...` page takes a typed name and a consent tick, checks the document's hash, and makes a signed PDF with a certificate page into the archive; the signed copy is another Outbox draft with that PDF attached. Telegram tells you when a client signs or declines (migration 031). |
| **C4** | Exact statutory interest and fixed compensation (integers only, rounded once), and the **Final demand** button on an overdue invoice: a letter built from statements the code writes and checks word for word, saved as an Outbox draft that always waits for your approval, sent with its PDF.                                                                                                                                                                                          |
| **C5** | The **Lawyer pack** button on the Project page: one PDF with a cover and contents, the signed agreement, every invoice, a timeline of everything sent and received, and any final demand.                                                                                                                                                                                                                                                                                                |

## Done-when checks

| Check                                                                                                                       | Result | Where                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| C1: `npm run legal:check` lists every entry as unapproved with its source; nothing cited until approved                     | Pass   | `tests/phase2/legal-gating.test.ts`; but the law table is empty (above), so only the 19 rates are listed                               |
| C2: a draft agreement previews with the right amounts, milestones and options; saved and voided                             | Pass   | `tests/phase2/agreements.test.ts`, and driven in a real browser                                                                        |
| C3: sent after approval, opened from the email, signed, signed PDF archived and attached                                    | Pass   | `tests/phase2/agreement-signing.test.ts`, and the whole flow in a real browser with real Chromium (Gmail was a fake)                   |
| C4: for a UK business client the draft shows the right interest, compensation, citation, deadline; sent only after approval | Pass   | `tests/phase2/statutory-interest.test.ts` and `final-demand.test.ts` (laws and rates approved in the tests' own fixtures); browser run |
| C5: the pack downloads as one PDF with cover, agreement, invoices, timeline and demands                                     | Pass   | `tests/phase2/lawyer-pack.test.ts` (real PDF merging), and a real-Chromium download                                                    |

Tests added (the plan's list, in `tests/phase2/`): C-S1 and C-S2 (agreements: row-level security, the freeze), C-S3 (signing), C-S4 (legal gating), C-M1 (interest maths against hand calculations), C-S5 (the final demand's checks and approval), C-S6 (the pack: access and paths). I also added tests for the pieces around them that the same rules covered (sending, the Outbox, the calendar's signing deadline, Telegram).

## Decisions to know about

- **Three new migrations, not two:** 029 (the facts), 030 (agreements), 031 (signing); the plan's single `029_contracts.sql` is split so each step has its own file.
- **A new dependency, `pdf-lib`** (MIT, no install scripts, nothing new in `npm audit`).
- **The signing page's Content-Security-Policy allows inline scripts and styles from the page itself,** because Next.js's start-up scripts are inline; the agreement is in a sandboxed frame that can run no script, and the page is `noindex` and unframeable.
- **The final demand and the signing emails can't be edited in the Outbox,** and a final demand can't be reworded by words either: their wording is checked against the facts, and an edit would be a way round it.
- **Interest is exact rational arithmetic in `BigInt`**, rounded half up once. The MSMED method (three times the bank rate, compounded monthly, a 30-day month for the leftover days) is written out in `lib/statutory-interest.ts` and `docs/DECISIONS.md` for you to confirm.
- **The "half year" reference date is the UK rule for every law that uses it.**
- **A signed agreement's late-payment clause replaces the project's own** in Tier 3 and the final demand.
- Full list: `docs/DECISIONS.md`, the "C1" to "C5" entries.

## What hasn't been checked

- **Real Gmail, real Telegram and a real model.** Every email path was run against fakes (in tests and in a real browser), including real Chromium PDFs, but never against Google. The signing email needs `APP_PUBLIC_URL` set to this app's public address, or "Send for signature" refuses.
- **The legal content.** The clause text, the final demand's fixed wording and the next steps it may name are mine, not a lawyer's. The MSMED compound-interest method and the half-year reference date are unconfirmed.
- **The seven laws:** none could be read from an official page, so none are in the table. Several sites answered 403 or empty; one attempt to read them another way was refused by the auto-mode check as a bot-check workaround, and I did not try others (`docs/NEEDS_YOU.md`, "Blocked commands").
- The screens are plain and unpolished, as the plan asked (the builder's checkboxes sit a little off, the preview frame is fixed-height).
- Known limits: a signing link's expiry is noticed when it is opened, not by a background job; the signing email isn't re-checked against the 30 days when it is finally sent; the signing-page rate limits live in this server's memory; the demand letter's letterhead is plain, not the invoice template's header.
- A load-related flake, seen once: the Paid stamp's reduced-motion E2E spec failed while I ran other commands alongside the suite and passed on a clean rerun. Run the E2E with nothing else going.

## What you need to do

Everything is in `docs/NEEDS_YOU.md`, at the top of "Open":

1. **Legal tables (C1):** open each law's official page, tell me or paste the text, and approve the entries you've checked; check the Bank of England, ECB and RBI rates (the RBI list is empty) and approve them. Keep the rates up to date.
2. **Fill in Settings > Legal details** (legal name, Udyam number, governing-law country) and each client's region and business flag.
3. **Have a lawyer read** the agreement template (C2) and the final demand's wording (C4), and **confirm the MSMED method** with an accountant or lawyer.
4. **Set `APP_PUBLIC_URL`, run `npm run db:migrate`** (029, 030, 031), and try the signing flow once with a second inbox against real Gmail.
5. Remember the deployment steps for `n8n/workflows/08_calendar_sync.json` from Part A if you haven't done them.
