# GetPaid user manual (help text)

This is the text of the GetPaid user manual (GetPaid-User-Manual.pdf), for the in-app help assistant. "Screen:" lines describe the screenshots in the PDF; numbers in [brackets] match the numbered markers in those screenshots.

**Chapter 1**

# What GetPaid does

GetPaid helps freelancers with clients abroad get paid on time. It protects the money before the work starts, and handles the polite follow-up after a due date, while you stay in charge of every message.

**1. Set up:** Client, project, milestones and your reminder rules, once.

**2. Invoice:** Each milestone becomes a PayPal invoice with a pay link.

**3. AI drafts:** When a payment is late, AI writes the reminder in the right tone.

**4. You approve:** On Telegram or in the Outbox. Nothing sends without you.

**5. Paid:** PayPal confirms through a verified webhook. Reminders stop.

## The main ideas

- **Your rules, the client's clock.** Payment terms, grace period, intervals and tiers are yours. Send times are worked out in the client's time zone and working hours.
- **Three tiers of tone.** A friendly reminder (Tier 1), a firm one (Tier 2) and a final notice (Tier 3), plus an optional courtesy note before the due date.
- **One pay link per invoice.** Every reminder for an invoice carries the same PayPal link, so the client always has one place to pay.
- **AI suggests, you decide.** The AI writes drafts and reads replies. It can never change an amount, a status, a schedule or an approval.
- **Protection before the work.** Deposits, milestone holds (PayPal authorizes money up front), installments, retainers with auto-pay, and online agreements.
- **A record when it goes wrong.** A timeline of everything sent and received, a final notice that only cites your contract or an approved law, and a one-click payment record for a lawyer.

**Sandbox only:** This build talks only to the PayPal sandbox, so no real money moves. Real emails go only to addresses you allow (chapter 19).

**Chapter 2**

# Before you start

What you need for each part. You can start with nothing but Node and Docker and add the rest later.

| For                              | You need                                                                                        | Where to get it                       |
|----------------------------------|-------------------------------------------------------------------------------------------------|---------------------------------------|
| Running the app                  | Node.js 22.9 or newer, Docker Desktop, Git                                                      | nodejs.org, docker.com                |
| Invoices and pay links           | A PayPal developer account and a sandbox app (client ID and secret)                             | developer.paypal.com                  |
| Sending emails from your address | A Google Cloud OAuth client with the Gmail API turned on                                        | console.cloud.google.com (chapter 18) |
| Approving from your phone        | A Telegram bot made with @BotFather                                                             | Telegram app (chapter 18)             |
| AI drafts                        | A cloud API key (Claude, OpenAI, Gemini, Groq or OpenRouter), or a free local model with Ollama | Settings \> AI (chapter 17)           |
| Automation                       | n8n, which starts with Docker; and for webhooks a public HTTPS address (a server or a tunnel)   | chapters 18 and 20                    |

**Without any keys:** The app still works: invoices can be created in the sandbox, drafts come from fixed templates when no AI model is set, and the Outbox works without Telegram.

## Safety rules that are always on

- Nothing is sent without your approval. Final notices (Tier 3) always wait for you, even if you let Tier 1 send on its own.
- Money is marked paid only by a signature-verified PayPal webhook, or by you, when you press **Record a payment** and confirm. Nothing in a client's email, an AI suggestion or a Telegram message can do it.
- A client's email can't change an invoice, an amount, a schedule or an approval, whatever it says.
- A draft that fails its checks (wrong amounts, invented dates, extra links) is never sent.
- API keys and tokens are encrypted when saved, and never shown again in the browser.

**Chapter 3**

# Install and run it

These steps are the same on Windows and macOS. On Windows, use PowerShell.

1.  **Get the code and install.**

        git clone https://github.com/dharmik-o/GetPaid.git
        cd GetPaid
        npm install
        npx playwright install chromium

    Chromium is what makes the invoice PDFs.

2.  **Create your settings file.** Copy `.env.example` to `.env` (`Copy-Item .env.example .env` on Windows, `cp .env.example .env` on macOS). Generate each secret with:

        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

    Fill in `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `N8N_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN` and `LITELLM_MASTER_KEY` (this one starts with `sk-`). Never share or commit this file.

3.  **Add your PayPal sandbox keys** as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (chapter 18). Run `npm run env:check`: it prints setting names only, never values.

4.  **Start the services:** `docker compose up -d --wait`. This starts Postgres and n8n (http://localhost:5678).

5.  **Set up the database,** once, in this order:

        npm run db:dev-auth
        npm run db:migrate
        npm run db:seed

    The seed adds a demo freelancer, the client Hudson Street Bakery and a USD 3,000 project to practise on.

6.  **Start the dashboard:** `npm run dev`, then open http://localhost:3000. The landing page is at http://localhost:3000/welcome.

**Optional extras:** `npm run local-ai:on` starts Ollama for free local models (about 1.5 GB once). `npm run gateway:on` starts the LiteLLM gateway. Neither is needed if you use a cloud AI key.

**Stopping and starting again:** `docker compose down` stops the services and keeps your data. Next time, run `docker compose up -d --wait` and `npm run dev` again.

**Chapter 4**

# Finding your way around

The landing page explains GetPaid to visitors. The dashboard is where you work.

*Screen: The landing page at /welcome. **Open dashboard** takes you into the app.*

## Home

*Screen: Home leads with what needs you today.*

1.  \[1\] **Needs attention:** drafts waiting for your approval, and overdue invoices with how many days late. Click a row to open it.
2.  \[2\] **Recovery:** the amount recovered, days saved compared with how late clients usually pay you, typical days late and your recovery rate. The Paid stamp marks each paid invoice.
3.  \[3\] **Sidebar:** Home, Outbox (with a count of drafts waiting), Clients, Projects, Calendar, Retainers, Maintenance and Settings. On a phone this becomes a bar at the bottom with a :** More** menu.
4.  \[4\] **Theme button:** switches between light and dark mode. Your choice is remembered.

*Screen: Lower on Home: \[1\] Upcoming (the next 90 days of retainer charges, maintenance and renewals, with expected income) and \[2\] your calendar for the next 7 days.*

## The guided tour

*Screen: Step 1 of the tour on Home.*

*Screen: The tour moves across pages by itself.*

On your first visit a short tour points at each part of the app. Press **Got it** to move on, :** Back** to go back, or :** Skip tour** (or Esc) to close it. Some pages, such as a project, the calendar and the agreement builder, show a few extra tips the first time you open them. To see the tour again, go to :** Settings \> Guided tour \> Replay tour**; :** Reset page tips** brings the page tips back.

## Ask GetPaid (the Help button)

*Screen: The Help button in the header, and its side panel.*

The **Help** button (a question mark, top right on every page) opens a side panel where you can ask how to use GetPaid in your own words, or press one of the suggestions: "How do I record a bank transfer?", "How do I connect Telegram?", "How do reminders work?".

The answer is written from this manual only. Under it, **From the manual** names the sections it used, there are links to the pages it mentions, and **Download the manual (PDF)** gets the full manual. If the manual doesn't cover your question, it says so rather than guessing. It can't change anything in your account: it only explains.

Ask GetPaid uses your own AI model. Pick one in **Settings > AI** (the per-task field **Help assistant** can use a different model; left empty it uses your main model). With no model set, it says "Set a model in Settings > AI". The Calendar's assistant also answers how-to questions about using GetPaid the same way.

**Chapter 5**

# Clients

Each client has a billing email, a country and a time zone. The time zone decides when their reminders go out.

*Screen: The Clients list: name, country, open balance and last activity.*

## Add a client

1.  Open **Clients** and press \[1\] :** Add client**.
2.  Fill in the form (below) and press **Add client**. Cancel takes you back to the list.

*Screen: The Add client form, filled in.*

| Field                           | What to enter                                                                                                             |
|---------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| \[1\] Name                      | The client's name or company, as it should appear in emails and invoices.                                                 |
| \[2\] Billing email             | Where reminders go. Replies on the invoice thread are read from here.                                                     |
| \[3\] Country                   | Sets the default time zone, and which late-payment laws could apply.                                                      |
| \[4\] Time zone                 | Filled in from the country; change it if the client works elsewhere. Reminders go out in the client's working hours here. |
| \[5\] This client is a business | Tick it for a company. Some late-payment laws cover business clients only, so untick it for a private person.             |
| \[6\] Add client                | Saves the client.                                                                                                         |

## A client's page

*Screen: A client's page.*

- \[1\] **Summary:** billing email, country, time zone and open balance. :** Edit details** is further down the page.
- \[2\] **Overview and Invoices tabs:** Invoices lists every invoice by project, with the total sent and paid per currency, and filters.
- \[3\] **Projects:** the client's projects, and :** New project** to start one for them.

## The timeline

*Screen: The client's timeline: every email sent, reply received, payment and change, newest first.*

Each row shows what happened, the invoice it belongs to and when, in your time and the client's. Click a row with a triangle to open the full email. Client replies show the **AI suggestion**, such as "Promises to pay"; it is only a suggestion. Payments show the yellow Paid badge.

**Chapter 6**

# Creating a project

A project holds the total, the deadline and the reminder rules for one piece of work. You set the rules once; every invoice in the project follows them.

*Screen: The Projects list. Press \[1\] **New project**, or open a project \[2\].*

## Step 1: Details

*Screen: Project details.*

| Field                            | What to enter                                                                                                                                             |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| \[1\] Client                     | Pick the client. Add them first if they're not listed.                                                                                                    |
| \[2\] Project name               | A short name the client will recognise, such as "Website redesign".                                                                                       |
| \[3\] Total                      | The full price, for example `2400.00`. Milestones are worked out from this.                                                                               |
| \[4\] Currency                   | The client's currency. INR isn't listed because PayPal can't receive rupee payments; bill in the client's currency and PayPal converts when you withdraw. |
| \[5\] Delivery deadline          | When the work is due.                                                                                                                                     |
| \[6\] Contract terms (optional)  | Agreed terms that a firm reminder (Tier 2) may quote.                                                                                                     |
| \[7\] Late-fee clause (optional) | Copy it exactly from your contract. Reminders mention a late fee only if this is filled in.                                                               |

## Step 2: Schedule

These rules decide when reminders are drafted. Each field shows the default; leave it alone to use your account default (Settings \> Default schedule). A project's rules override the account's, a milestone's override the project's.

*Screen: Fields 1 to 4.*

*Screen: Fields 5 to 10.*

| Setting                          | What it does                                                                                            | Default                   |
|----------------------------------|---------------------------------------------------------------------------------------------------------|---------------------------|
| \[1\] Payment terms              | When an invoice is due: on receipt, Net 7, 14, 30, 45, 60, or a specific date.                          | Net 14                    |
| \[2\] Courtesy note              | A friendly heads-up this many days before the due date.                                                 | 2 days                    |
| \[3\] Grace period               | Days after the due date before the first reminder.                                                      | 0                         |
| \[4\] Reminder interval          | Every N days, or on specific dates you list.                                                            | Every 3 days              |
| \[5\] Reminders per tier         | How many reminders at one tier before moving up.                                                        | 2                         |
| \[6\] Nudge me                   | If you haven't answered a draft after this many hours, Telegram reminds you once. The draft stays held. | 24 hours                  |
| \[7\] Tiers start on day overdue | The day each tier begins: Tier 1 friendly, Tier 2 firm, Tier 3 final notice.                            | 1, 8, 22                  |
| \[8\] Send window                | The days and hours (client time) when emails may go out.                                                | Mon to Fri, working hours |
| \[9\] Approval                   | "Approve every message", or "Send Tier 1 without asking". Tier 3 always waits for you.                  | Approve every message     |
| \[10\] Create project            | Saves the project and opens it.                                                                         |                           |

**Live preview:** As you change the schedule, a line under it shows what will happen, for example "First reminder: Thu 31 Dec, 09:00 client time, then every 3 days".

**Chapter 7**

# Milestones and billing

A project page shows the summary, the agreement, the milestones, the invoices and their history.

*Screen: The top of a project: \[1\] Summary with the schedule in words, \[2\] Agreement (chapter 14), \[3\] Lawyer pack (chapter 15).*

## Split the work into milestones

*Screen: The milestone editor.*

1.  In \[1\] **Milestones**, give each milestone a name, a share (a percentage or an amount), a deadline and a payment mode.
2.  Press \[2\] **Add milestone** for more rows; use the arrows to reorder and :** Remove** to delete.
3.  The running total must equal the project total. Press \[3\] **Save milestones**.
4.  As the work goes on, press **Mark in progress** and :** Mark delivered** on each row. The status column follows the money: Planned, In progress, Delivered, Invoiced, Paid.

| Payment mode   | What happens                                                                                                                                                                                                                                                               |
|----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Pay on invoice | When the milestone is delivered, you create a PayPal invoice for it.                                                                                                                                                                                                       |
| Deposit        | An invoice for the deposit is created before work starts ("Deposit due at kickoff").                                                                                                                                                                                       |
| Milestone hold | PayPal authorizes the money up front, and you capture it when the client accepts the work. If the work is cancelled you void it and nothing is taken. PayPal holds an authorization for up to 29 days; GetPaid reauthorizes after PayPal's 3-day honor period when needed. |

## Bill your milestones

*Screen: Bill your milestones: invoiced, paid and outstanding at the top, then one card per milestone.*

1.  On a milestone card \[1\], press **Create invoice** (or :** Create deposit invoice**). A PayPal sandbox invoice is made and sent.
2.  \[2\] **PayPal pay link** opens the invoice the client sees; :** Copy** copies the link.
3.  \[3\] **Invoice PDF** downloads the branded PDF (chapter 16).
4.  The card shows the stamp and badge: PAID, OVERDUE, the amount paid of the total, and when the next reminder goes.

### Installments

To let a client pay in parts, use **Pay in installments** on an invoice: set each part's amount and due date, then :** Save installments**. The open invoice is replaced by separate PayPal invoices, each with its own due date and reminders. The same split can come from a client's reply (chapter 9).

### Record a payment (client paid outside PayPal)

A client may pay by bank transfer, UPI, cash, cheque or another app. You close the invoice yourself:

1.  On the invoice's milestone card, or in the invoice history, press **Record a payment**. On a client's reply labelled "Says they've paid", press **Record their payment**: the same form opens.
2.  Pick the **Method** (Bank transfer, UPI, Cash, Cheque, Wise/other app, Other). The **Amount** starts as what is still owed, and can't be more. **Date received** can't be in the future. A **Reference or note** is optional (up to 200 characters).
3.  Press **Review**. The next step says exactly what will happen. Press **Confirm and record**.

GetPaid tells PayPal first, so the PayPal invoice and its pay link stop being payable, then reads the invoice back from PayPal. If PayPal refuses, nothing changes and you see why. When the whole amount is recorded the invoice turns Paid, the stamp drops, its reminders stop, and the timeline shows "Payment recorded by you". A part payment leaves it Partially paid with the rest still owed. The client is not emailed. A later PayPal message about the same payment is never counted twice. The invoice history and the lawyer pack show how each invoice was paid.

Only you can do this. The AI never records a payment, and nothing in a client's email can.

### Cancel an invoice

Press **Cancel invoice** on a milestone card, pick a reason (Agreed not to charge, Client won't pay — writing it off, Mistake, Other) and confirm. The client can no longer pay it, its reminders stop, and the card shows Cancelled. An invoice that already has money on it can't be cancelled; if you agreed to give money back, refund it in PayPal.

### Complete a project

When every invoice is paid or cancelled, press **Mark project complete** in the project's summary. The project gets a Completed badge and its waiting reminders stop. Any milestone hold still open must be captured or voided first, and GetPaid says so if one is.

### Archive or delete a project

At the bottom of a project page, the **Danger zone** card has two choices.

- **Archive project** hides the project from the Projects list, the client's page and Home, and stops its reminders. Every record stays. On the Projects list, press **Show archived** to see archived projects, open one and press **Restore project** to bring it back (reminders are planned afresh).
- **Delete project** removes the project for good, with its milestones, invoices, reminders, agreements, holds, maintenance jobs and calendar items. Type the project's name exactly to confirm. Invoice PDFs already saved in your invoice archive folder stay on disk; GetPaid never deletes them.

If the project still has unpaid PayPal invoices or open holds, the card lists them and asks you to tick **Cancel them in PayPal too**. GetPaid then cancels the invoices and voids the holds first. If PayPal refuses any of them (for example, an invoice that already has some money on it), nothing is deleted and you see why.

### Delete one milestone or one retainer

In the milestone editor, a saved milestone with no invoice and no hold has a **Delete** button next to Remove; it goes at once. A milestone that has ever had an invoice or a hold can't be deleted, so the record stays. A retainer that has never charged (no invoice, nothing paid, no auto-pay still set up in PayPal) has a **Delete retainer** button; any other retainer can only be cancelled.

### Invoice history

*Screen: Every invoice and saved version.*

Filter by \[1\] status and dates, then press \[2\] **Filter**. \[3\] :** Download PDF** gets the exact PDF that was sent. An overdue invoice also shows :** Final demand** (chapter 15).

**Chapter 8**

# The Outbox: approving reminders

Every email GetPaid wants to send waits here first. You read exactly what the client will see, then decide.

*Screen: The Outbox tabs.*

- \[1\] **Waiting:** drafts that need you. \[2\] :** Scheduled:** approved, waiting for the client's send window. \[3\] :** Sent** and \[4\] :** Skipped:** history.
- The Outbox refreshes by itself. A draft approved on Telegram leaves the Waiting tab without a reload.

## A reminder draft

*Screen: A Tier 2 reminder drafted by AI: client, invoice, amount, send time in both time zones, the full email and the PayPal pay link.*

*Screen: The parts of a draft card.*

1.  \[1\] **Send time:** when it goes, in the client's time and yours.
2.  \[2\] **Kind:** Courtesy, Friendly (Tier 1), Firm (Tier 2), Final notice (Tier 3), agreement emails and more.
3.  \[3\] **Approve and send:** it goes out in the client's send window, from your Gmail, on the invoice's email thread.
4.  \[4\] **Edit:** change the wording yourself. The checks run again before it can send.
5.  \[5\] **Reschedule:** pick another send time.
6.  \[6\] **Skip:** don't send this one. The schedule carries on.

## Approving from your phone

*Screen: A draft as a Telegram card.*

With Telegram connected (chapter 18), each draft also arrives as a card with **Approve**, :** Edit** and :** Skip** buttons.

- **Approve** schedules it, exactly like the Outbox button.
- **Edit**, then reply in plain words, such as "mention the 15th", and the AI redrafts it. The new draft comes back for approval.
- Buttons only work from your own linked chat, and a card stops working once the draft is handled anywhere.

## What the client receives

*Screen: A short email with one link: the PayPal invoice.*

**Chapter 9**

# Client replies and AI suggestions

When a client writes back on the invoice thread, that invoice's reminders pause, and the reply appears under "Replies to review" in the Outbox.

*Screen: A reply with the AI's reading of it, and what you can do next.*

1.  Read the client's words at the top of the card.
2.  The chip shows the **AI suggestion**, with one plain sentence: here, "The client says they'll pay on Friday".
3.  Choose what to do. For a promise: **Pause until** that date, :** Resume reminders**, or :** Offer a split instead**.

| AI label             | Meaning                                  | Typical next step                                                            |
|----------------------|------------------------------------------|------------------------------------------------------------------------------|
| Promises to pay      | The client names a date                  | Pause until that date                                                        |
| Asks to pay in parts | For example "half now, half on the 15th" | Approve the suggested split; the invoice is replaced by installment invoices |
| Says they paid       | Paid elsewhere, or already paid          | Check your account, then press **Record their payment** and confirm it      |
| Dispute              | The client questions the work or amount  | Talk to the client; reminders stay paused                                    |
| Out of office        | An auto-reply with a return date         | Pause until they're back                                                     |
| Unclear              | Anything else                            | Read it and decide                                                           |

**The AI only suggests:** Nothing in a client's email can change an invoice, an amount, a schedule or an approval by itself. Reminders for that invoice stay on hold until you decide.

**Chapter 10**

# Getting paid

The client pays through the PayPal link. PayPal tells GetPaid through a webhook, and the invoice is marked paid.

*Screen: Both milestones paid: the PAID stamps, the Paid badges and the full progress bars.*

1.  The client opens the link and pays with PayPal (in the sandbox, a sandbox buyer account).
2.  PayPal sends a webhook. GetPaid checks its signature with PayPal first, then reads the invoice's real state from PayPal.
3.  The invoice turns Paid, the stamp drops on the card once, the reminders for that invoice stop, and the payment appears on the client's timeline and in Recovery on Home.

**Sandbox buyer:** Use a **US Personal** sandbox buyer. A buyer from some countries, India for one, gets "The seller doesn't accept payments in your currency".

### Partial payments and refunds

A part-paid invoice shows Partially paid and the next reminder is for what is left. Refunds and disputes from PayPal show on the invoice and the timeline.

**Chapter 11**

# Retainers

A retainer bills the same amount every week or month.

*Screen: Add retainer.*

| Field                                | What to enter                                                                                                                                                           |
|--------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| \[1\] Client (and project, optional) | Who pays, and the project it belongs to if any.                                                                                                                         |
| \[2\] Name                           | For example "Monthly care plan".                                                                                                                                        |
| \[3\] Amount and currency            | The amount per cycle.                                                                                                                                                   |
| \[4\] Repeat every                   | A number of weeks or months.                                                                                                                                            |
| \[5\] First charge, last charge      | Leave the last charge empty to run until cancelled.                                                                                                                     |
| \[6\] Payment method                 | **Invoice each cycle**: a PayPal invoice every cycle, with normal reminders. :** Auto-pay**: the client approves a PayPal subscription once and is charged automatically. |
| Include my signature                 | Adds your signature to the invoices (set one up in Settings \> Invoice templates first).                                                                                |
| \[7\] Add retainer                   | Saves it.                                                                                                                                                               |

*Screen: The Retainers list. Each card shows the next charge and its status; **Cancel retainer** stops it.*

With auto-pay, an email asking the client to approve the subscription waits in your Outbox. If a charge fails, the subscription is suspended and a catch-up invoice takes over with the normal reminders, so the client is never charged twice.

**Chapter 12**

# Maintenance and renewals

Reminders for you, not the client: recurring jobs and renewals such as domains, hosting and SSL.

*Screen: Add maintenance job.*

| Field                                 | What to enter                                       |
|---------------------------------------|-----------------------------------------------------|
| \[1\] Project                         | The project the job belongs to.                     |
| \[2\] Type                            | Maintenance job, or Renewal (domain, hosting, SSL). |
| \[3\] Task                            | What needs doing.                                   |
| \[4\] Repeat every (months)           | How often.                                          |
| \[5\] Next due                        | The next date it's due.                             |
| Estimated cost                        | Optional. Shows as expected income on Home.         |
| \[6\] Remind me this many days before | When you hear about it on Telegram and Home.        |
| Count the next date from              | The date it was due, or the date it was done.       |
| Checklist                             | Optional, one item per line.                        |

*Screen: A job card: **Tell the client** drafts a heads-up email, :** Create invoice** bills the job, :** Snooze 7 days**, :** Reschedule**, :** Mark done**.*

**Chapter 13**

# Calendar

Deadlines, due dates, reminders, retainer charges, maintenance, your own entries and imported calendars, in one month view.

*Screen: The month view.*

- \[1\] **Previous**, \[2\] :** Today** and :** Next** change the month without reloading the page.
- Colours are a hint: gold is your own entries, red deadlines, white money, grey reminders and jobs. A dot marks a client meeting.
- **Click any day** to open it.
- **Export:** :** Download .ics** saves your GetPaid dates for any calendar app, and each item has :** Add to Google** and :** Add to Outlook** links.

*Screen: A day's panel.*

### The day panel

- Each item shows its kind, a one-line description and a link to its page, such as **Open invoice** or :** Open maintenance**.
- App dates (deadlines, invoices, reminders) are read-only here; change them on their own page.
- Your own entries have **Edit** and :** Delete**.
- **Add entry on this day** opens a short form with the date filled in.
- Esc or **Close** closes the panel.

## Ask about your calendar

*Screen: The assistant answers from your calendar only, and links the items it used.*

1.  Press a suggestion \[1\] such as **Deadlines next week**, or type your own question in \[2\], then press :** Ask**.
2.  If you ask for a change ("Move the logo review to Friday"), the assistant proposes it. Nothing changes until you press **Apply**, and it can only change your own entries.
3.  Set its model in Settings \> AI \> Calendar assistant.

## Add your own entry

*Screen: The entry form: \[1\] title, \[2\] kind (task, event, deadline or call), \[3\] date, \[4\] times (empty for all day), \[5\] link to a client or project, \[6\] a Telegram reminder that morning.*

## Import another calendar

*Screen: Imported calendars, from \[3\] on the assistant picture.*

1.  In Google Calendar: Settings, pick your calendar, **Integrate calendar**, and copy :** Secret address in iCal format**. Outlook and Apple Calendar have a similar "publish" or "share" address.
2.  Give it a \[1\] name, paste the address in \[2\], pick a colour and press \[3\] **Add calendar**. It refreshes every 30 minutes through n8n.
3.  Or upload an \[4\] .ics file once.

**Chapter 14**

# Agreements and e-signatures

Build an agreement from the project's own milestones, then have the client sign it in the browser.

**Not legal advice:** The agreement text is a fixed template. Have a lawyer read it before you use it with real clients.

*Screen: The options.*

*Screen: The live preview.*

1.  Open the project and press **Create agreement** in the Agreement card.
2.  Set the options: deposit percentage, days to pay each invoice, rounds of revisions, days to accept a deliverable, cancellation fee, who owns the work and when, the late-payment terms, the **country whose law governs the agreement**, and whether both sides keep business information confidential and you may show the work in your portfolio.
3.  Press **Create draft**. The preview below shows exactly what the client will read.
4.  Type your full name under **Send for signature** and press the button. This signs it for you and freezes the document. An email with the signing link waits in your Outbox; nothing reaches the client until you approve it.

*Screen: The client's signing page.*

*Screen: After signing.*

1.  The client opens the link, reads the agreement, types their full name, ticks the box and presses **Sign**, or :** Decline** with a reason.
2.  A copy of the signed agreement with its signing certificate (names, times, and a fingerprint of the document) goes to the client after you approve that email, and the project shows **Signed PDF**.
3.  To change a signed or sent agreement, make a **New version**. A sent one can be :** Voided**.

**Chapter 15**

# Final notice and lawyer pack

When polite reminders don't work, GetPaid drafts a formal final notice and gathers everything into one PDF.

## Make a final demand

*Screen: Final demand on an overdue invoice, in the project's invoice history.*

1.  On an overdue invoice, press **Final demand**.
2.  Choose **Days to pay** (7 to 14) and press :** Make the final demand**.
3.  The letter waits in your Outbox. Read it closely before you approve it.

*Screen: The letter cites the signed agreement's late-payment clause, the amount, the new deadline and the pay link.*

**What a final notice may say:** It may cite only your contract's late-fee clause or a law that you've checked and approved in the app's law table. Interest and compensation are worked out only under an approved law and reference rate. If there's neither, it is simply a final notice. It never invents a law, a fee or a deadline, and it's marked "not legal advice" for you.

## Lawyer pack

On the project page, press **Lawyer pack**. You get one PDF with the parties, the project, every invoice with what's paid and outstanding, the signed agreement and its certificate, and a timeline of everything sent and received. A copy also goes into your invoice archive.

*Screen: Cover and contents.*

*Screen: The signed agreement.*

*Screen: Signature certificate.*

**Chapter 16**

# Invoice templates and PDFs

Choose how your invoice PDFs look, and add your business details, logo and signature.

*Screen: Settings \> Invoice templates.*

1.  \[1\] Pick from the built-in themes (Classic, Modern, Minimal, Studio, Ledger and more) and press **Preview**.
2.  \[2\] **Duplicate** a theme to edit your own copy in HTML; your HTML is cleaned and rendered with scripts and network off.
3.  \[3\] **Set as default** uses it for new invoices.

*Screen: Your invoice details.*

| Field               | What it does                                                                                               |
|---------------------|------------------------------------------------------------------------------------------------------------|
| \[1\] Business name | Shown instead of your name where a template uses it.                                                       |
| \[2\] Address       | Printed on the invoice.                                                                                    |
| \[3\] Logo          | PNG, JPEG, GIF or WebP, under 200 KB.                                                                      |
| \[4\] Paper size    | A4 or Letter.                                                                                              |
| \[5\] QR code       | Prints a QR code of the PayPal pay link.                                                                   |
| \[6\] Signature     | None, an uploaded image, or your typed name drawn as a signature. It's a picture, not a legal e-signature. |

*Screen: An invoice PDF.*

### The invoice archive

Every PDF that is sent is also saved in your invoice archive folder, by client and project, and listed in each project's invoice history. The folder is shown in **Settings \> Invoice archive** with a :** Copy** button. It holds client data, so back it up.

**Chapter 17**

# Settings

## General

*Screen: Settings, top.*

| Section                                | What to set                                                                                                                                             |
|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| \[1\] Time zone                        | Your own time zone. Times are shown in both yours and the client's.                                                                                     |
| \[2\] How late clients usually pay you | Days after the due date. Home compares results against this to show days saved.                                                                         |
| \[3\] Legal details                    | Your legal name for contracts, your Udyam (MSME) number if you have one (India's MSMED Act needs it), and the country whose law governs your contracts. |

*Screen: Settings, lower.*

| Section               | What it does                                                                                                                     |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------|
| Invoice templates     | Opens chapter 16's page.                                                                                                         |
| \[4\] Invoice archive | Shows where PDFs are saved.                                                                                                      |
| \[5\] Guided tour     | **Replay tour** and :** Reset page tips**.                                                                                         |
| Integrations          | Opens Telegram, Gmail and PayPal (chapter 18).                                                                                   |
| \[6\] Demo clock      | Development only: move the app's clock forward by days (18.5 is 18 days and 12 hours) to show overdue reminders without waiting. |
| Default schedule      | Your account-wide reminder rules, the same fields as chapter 6.                                                                  |

## AI

*Screen: Settings \> AI.*

1.  \[1\] Pick a **Provider**: Claude (Anthropic), OpenAI, Gemini, Groq, OpenRouter, Ollama (local), LM Studio (local) or a custom URL.
2.  \[2\] The **Base URL** fills in for you. \[3\] Paste the :** API key**; it's encrypted and never shown again. Local models need no key.
3.  \[4\] Type the **Model**, for example `claude-sonnet-5-5`, or `llama3.2` for Ollama.
4.  \[5\] Optionally choose different models per task: sorting replies (a small model is enough), Tier 3 final notices (the strongest), and the calendar assistant.
5.  Press \[6\] **Save AI settings**.

*Screen: \[7\] Local AI and \[8\] Test connection.*

With Local AI on (`npm run local-ai:on`), press **Download** next to a model such as `llama3.2` or `qwen2.5:3b`. :** Test connection** sorts two sample replies and drafts a Tier 1 and a Tier 2 email with made-up data, and shows the results. A cloud main model falls back to a fixed template if it fails; a local main model can also fall back to a cloud model.

## Integrations

*Screen: Settings \> Integrations: \[1\] Telegram, \[2\] Gmail and \[3\] PayPal, each with its status.*

**Chapter 18**

# Connecting PayPal, Telegram, Gmail and AI

Do these once. Settings go in your `.env` file; restart `npm run dev` after changing it.

## PayPal sandbox

1.  Go to developer.paypal.com, then **Apps & Credentials**, with :** Sandbox** selected. Create an app and copy its keys into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2.  Under **Sandbox accounts**, create or find a :** US Personal** account to pay with.
3.  In your app, add a webhook at `https://<your public address>/webhook/paypal`. Subscribe to `INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.SALE.COMPLETED` and the `BILLING.SUBSCRIPTION.*` events.
4.  Copy the webhook's ID into `PAYPAL_WEBHOOK_ID`.

## n8n (automation)

1.  Open http://localhost:5678 and create the n8n owner account.
2.  Add a **Header Auth** credential named `App internal API token`: name `Authorization`, value `Bearer ` followed by your `INTERNAL_API_TOKEN`. Put "Bearer" only here, never in `.env`.
3.  Import the eight workflows (scheduler, drafter, approval handler, sender, reply listener, PayPal webhook, AI router, calendar sync) and publish them: `npm run n8n:go-live`.
4.  Set `WEBHOOK_URL` to your public HTTPS address, so PayPal and Telegram can reach n8n.

## Telegram

1.  In Telegram, message **@BotFather**, send `/newbot`, choose a name and a username ending in "bot", and copy the token.
2.  Put the username in `TELEGRAM_BOT_USERNAME`. Add the token as the Telegram credential in n8n.
3.  In GetPaid, open **Settings \> Integrations \> Telegram** and press :** Connect**. Telegram opens your bot; press :** Start**. The page then shows "Connected".

## Gmail

1.  At console.cloud.google.com, create a project and enable the **Gmail API**.
2.  On the OAuth consent screen (Google Auth Platform), pick **External**, add the scopes `gmail.send` and `gmail.readonly`, leave it in :** Testing** and add your sending address as a test user.
3.  Create an OAuth client of type **Web application** with this redirect URI: `http://localhost:3000/api/integrations/gmail/callback` (on a server, use your domain instead).
4.  Copy the ID and secret into `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`, restart, then press **Connect Gmail**. Google warns the app isn't verified; choose :** Advanced \> Go to app**.
5.  In Testing mode Google ends the connection after 7 days. Sends are then held, and you're told to reconnect.

**Least access:** GetPaid only sends, and only reads the email threads of invoices it sent. It never reads the rest of your inbox.

## AI provider

Create an API key with your provider (for example console.anthropic.com for Claude) and paste it in Settings \> AI (chapter 17). Or run a free local model with Ollama and pick it there. With a local model, client emails never leave your machine.

**Chapter 19**

# Who can receive emails

To keep tests and demos safe, real emails can only go to addresses you list. That's why every test email lands in your own second inbox.

The setting is `DEV_EMAIL_ALLOWLIST` in `.env`: a comma-separated list of addresses. An email to anyone else is held, not sent, and the Outbox says why. Empty means nothing sends.

    DEV_EMAIL_ALLOWLIST=my.second.inbox@gmail.com,judge.demo@example.com

1.  Give each test client in GetPaid a **Billing email** that's on the list, such as your own inboxes or a demo inbox you share.
2.  To let someone else receive emails during a demo, add their address to the list and restart the app (or the web container on a server).
3.  Keep the list short. Don't add a real client you don't mean to email.

**This is deliberate:** The project's safety rules allow sandbox payments and allow-listed emails only. Emailing any client freely is a change for a real launch, with real sign-in and live PayPal; it isn't a setting to switch off for the demo.

### Sending from a different Gmail

Emails go from the Gmail account you connected. To send from another address, press **Disconnect Gmail** and connect the other account (add it as a test user in Google first).

**Chapter 20**

# Running a live demo

For judges to click a link, run GetPaid on a small always-on server with HTTPS. Your keys then live on that server, not your laptop. The full runbook is `docs/DEPLOY.md`; this is the short version.

**Server:** Oracle Cloud Always Free Arm VM: Ubuntu 24.04, 2 OCPU, 12 GB.

**Address:** A free DuckDNS name pointed at the server's IP.

**HTTPS:** Caddy gets a certificate by itself and sends /webhook/\* to n8n.

**Gate:** A demo password page in front of everything.

1.  Create the VM, reserve its public IP, and open ports 80 and 443. Upgrade the account to Pay As You Go and set a \$1 budget alert, so the free server isn't reclaimed when idle.
2.  Point your DuckDNS name at the IP (and clear the IPv6 box).
3.  On the server: clone the repo, run `bash deploy/server-setup.sh`, and create a new `.env` with **new** secrets. Set `DOMAIN`, `APP_PUBLIC_URL`, `WEBHOOK_URL`, `DEMO_MODE=true`, a `DEMO_USERNAME` and an 8+ character `DEMO_PASSWORD`, `DEMO_COOKIE_SECRET`, and `DEV_EMAIL_ALLOWLIST`.
4.  Start it: `docker compose up -d --build --wait`, then run the database steps.
5.  Point the outside services at the new address: the PayPal webhook URL, the Google OAuth redirect URI, and the n8n workflows (Telegram is re-registered when you publish).
6.  Add your AI key in Settings \> AI, connect Gmail and Telegram, and share the link and the demo password.

*Screen: The demo password page visitors see first.*

**Backups:** `deploy/backup.sh` saves the database daily; copy backups off the server too. The invoice PDFs on the server hold client data as well.

**Chapter 21**

# Troubleshooting

| What you see                                      | What to do                                                                                                                            |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| Telegram: "Not authorized" in n8n                 | The n8n credential value must be `Bearer <token>`; `.env` holds the token alone. Check both match.                                    |
| Telegram buttons do nothing                       | The workflows must be published and `WEBHOOK_URL` must be public HTTPS. Run `npm run n8n:go-live` again after the address changes.    |
| "Seller doesn't accept payments in your currency" | Pay with a US Personal sandbox buyer.                                                                                                 |
| An approved email isn't sent                      | Check the client's address is in `DEV_EMAIL_ALLOWLIST`, Gmail is connected, and the send window has opened.                           |
| Gmail stopped sending after a week                | Testing mode ends the connection after 7 days. Press Connect Gmail again.                                                             |
| An invoice stays unpaid after paying              | The PayPal webhook must reach `/webhook/paypal`, and `PAYPAL_WEBHOOK_ID` must match. Failed signature checks are rejected and logged. |
| AI drafts look like templates                     | No model is set, or it failed. Use Test connection in Settings \> AI.                                                                 |
| A local model is slow                             | Small local models can take a minute. Use a cloud model for drafting and keep the local one for sorting.                              |
| "Couldn't answer that reliably" in the calendar   | Ask about a specific week, or set a stronger model for the calendar assistant.                                                        |
| The app won't start                               | Run `npm run env:check`. It names the missing or wrong setting.                                                                       |

**Appendix A**

# Environment settings

Names only; never share the values.

| Setting                                                   | What it's for                                              |
|-----------------------------------------------------------|------------------------------------------------------------|
| POSTGRES_PASSWORD, DATABASE_URL                           | The database.                                              |
| ENCRYPTION_KEY                                            | Encrypts saved keys and tokens. Don't change it later.     |
| N8N_ENCRYPTION_KEY                                        | n8n's own credentials.                                     |
| INTERNAL_API_TOKEN                                        | Lets n8n call the app's internal routes.                   |
| LITELLM_MASTER_KEY                                        | The optional AI gateway (starts with `sk-`).               |
| PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID | The PayPal sandbox app and its webhook.                    |
| GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET                      | The Google OAuth client.                                   |
| TELEGRAM_BOT_USERNAME                                     | Your bot's username.                                       |
| DEV_EMAIL_ALLOWLIST                                       | The only addresses real emails may go to.                  |
| WEBHOOK_URL, APP_PUBLIC_URL                               | Your public addresses, for webhooks and links in Telegram. |
| LOCAL_AI_URL                                              | Where Ollama runs.                                         |
| INVOICE_ARCHIVE_DIR                                       | Where invoice PDFs are saved.                              |
| DOMAIN, DEMO_MODE, DEMO_PASSWORD, DEMO_COOKIE_SECRET      | The public demo server.                                    |
| DEMO_CLOCK_OFFSET_DAYS                                    | Development: start with the clock moved forward.           |

**Appendix B**

# Statuses and terms

| Badge                                                                | Meaning                                                                  |
|----------------------------------------------------------------------|--------------------------------------------------------------------------|
| Paid                                 | The full amount arrived: PayPal confirmed it through a verified webhook, or you recorded it. |
| Partially paid                            | Some of it is paid; reminders continue for the rest.                     |
| Sent Scheduled | The invoice is out, or an approved email is waiting for the send window. |
| Overdue                              | Past the due date, with the number of days.                              |
| Draft                               | Not sent yet.                                                            |
| Cancelled, Refunded, Disputed                                        | Changed in PayPal; shown on the invoice and the timeline.                |

| Term           | Meaning                                                                    |
|----------------|----------------------------------------------------------------------------|
| Courtesy note  | A friendly heads-up before the due date.                                   |
| Tier 1, 2, 3   | Friendly reminder, firm reminder, final notice.                            |
| Grace period   | Days after the due date before the first reminder.                         |
| Send window    | The client's days and hours when emails may go out.                        |
| Milestone hold | Money authorized in PayPal before work starts, captured on acceptance.     |
| Installments   | One invoice replaced by several, each with its own due date.               |
| Retainer       | A repeating charge, by invoice or PayPal auto-pay.                         |
| Webhook        | PayPal's message to GetPaid that something changed, always verified first. |
| Allowlist      | The only email addresses real emails may go to (chapter 19).               |
