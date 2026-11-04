# Demo script

The full loop in about 5 minutes: a late invoice, an approved reminder, a client who asks to split it, and the money coming in. The dev-only demo clock jumps over the days in between.

`npm run test:e2e` runs these same 8 steps with PayPal, Gmail and the model faked, and it passes. **This script hasn't been run live as a whole**, so rehearse it once. It's the only real test of steps 2, 3, 4 and 6 end to end.

## Before you start (allow 20 minutes)

**Start from a clean slate. This one matters.** The demo clock moves everything on this account, not just the demo project. Your test clients' invoices go overdue and get reminder drafts, and an invoice-method retainer raises a real sandbox invoice when its date passes. Nothing can email a client without your approval, but your Outbox and Telegram would fill up in front of the audience. So once your live checks are finished, delete your test clients: on each client's page, press **Delete client**. It's refused while a client has an active auto-pay or a live hold, so cancel or void those first. If you'd rather keep that data, use a separate database for the demo.

1. Start Docker Desktop, then run `docker compose --profile ollama up -d --wait`.
2. Run `npm run db:migrate`, then `npm run db:seed`. This adds Hudson Street Bakery and its USD 3,000 project.
3. Run `npm run dev`, and start your tunnel so PayPal's webhooks reach n8n. If the tunnel's address changed, follow "Fixed tunnel address" in `docs/NEEDS_YOU.md`.
4. Check n8n at http://localhost:5678: Scheduler, Approval handler, Sender, Reply listener and PayPal webhook must all be active.
5. In **Settings > Integrations**, check Gmail and Telegram both say connected. Gmail's Testing mode ends the connection after 7 days, so reconnect it the day before if needed.
6. In **Settings > AI**, set the main model to **Claude** with your key, and press Test connection. With no key, use Ollama (`llama3.2`) here and swap the order in step 7. Press Test connection either way.
7. On **Clients > Hudson Street Bakery**, under Edit details, set the billing email to your second inbox. It must be listed in `DEV_EMAIL_ALLOWLIST`, or the send is refused.
8. Have ready:
   - A browser signed in to a **US Personal sandbox buyer**. An Indian buyer gets "seller doesn't accept payments in your currency". Find one in the PayPal developer dashboard under Sandbox > Accounts.
   - Your second inbox open in another tab.
   - Telegram open on your phone, and ideally on screen.
   - Tabs for the dashboard's Home, Outbox and the project. n8n's Scheduler and Reply listener workflows open, for running them by hand.

**The send window.** Emails only go out from 9:00 to 17:00 New York time, which is 19:30 to 03:30 in India during New York's winter (18:30 to 02:30 in its summer). Drafts and Telegram cards appear at any hour. If you're presenting outside the window, add part of a day to each jump in Settings so the clock lands inside it. For example, at 14:00 in India it's 03:30 in New York, so add 0.25 (6 hours) for 09:30: enter 21.25 instead of 21, and 22.25 instead of 22. Check by looking at the "client time" on the draft.

**Running a job by hand.** The Scheduler runs hourly and the Reply listener every 5 minutes, which is too slow for a demo. In n8n, open the workflow and press **Execute workflow**. I haven't tried that on your n8n, so check it during the rehearsal. The fallback, with your token from your env file:

```
curl -X POST http://127.0.0.1:3000/api/internal/scheduler/run -H "Authorization: Bearer <INTERNAL_API_TOKEN>"
curl -X POST http://127.0.0.1:3000/api/internal/replies/run -H "Authorization: Bearer <INTERNAL_API_TOKEN>"
```

The Sender and the Telegram cards run every minute by themselves.

## The 8 steps

### 1. Set up (20 seconds)

- **Click:** Projects > Website redesign.
- **Say:** "A freelancer in India, a client in New York, USD 3,000 in three milestones: a 30% deposit, then 50% and 20%. Net 7, a reminder every 3 days, only in the client's working hours."
- **On screen:** the Projects list first, then USD 900, 1,500 and 600, and the schedule line under Summary.
- **If someone asks how a project gets set up:** on the Projects list, press **New project**. The form opens on its own page, and **Cancel** goes back to the list. **Add client**, **Add retainer** and **Add maintenance job** work the same way on their lists.

### 2. Deposit (40 seconds)

- **Click:** under Invoices on the Design row, type `900.00` as the deposit, then **Create deposit invoice**. Open **PayPal pay link** and pay as the sandbox buyer.
- **Say:** "The deposit protects the freelancer before work starts. The app gets PayPal's word for it, not the client's."
- **On screen:** after the webhook arrives, refresh: Design shows **Paid**.
- **If it's slow:** the webhook goes PayPal, tunnel, n8n, app, so give it 30 seconds. Say what's happening and carry on: nothing later depends on it.

### 3. Overdue (60 seconds)

- **Click:** under Milestones on the Build row, **Mark in progress**, then **Mark delivered**. Under Invoices, **Create invoice** on Build. Then **Settings > Demo clock**, enter `21`, and press **Set the clock** (Net 7 plus 14 days overdue). Run the Scheduler. Open the Outbox and leave it showing.
- **Say:** "Three weeks later and nobody's paid. The AI writes a firm reminder, but nothing goes out until I approve it."
- **On screen:** a banner saying the clock is 21 days ahead. A **Tier 2** draft for USD 1,500.00, with the send time in both zones.
- **On Telegram:** within a minute, a card with the client, amount, tier and message. Tap **Approve**.
- **On screen:** within 10 seconds, with no touching, the card leaves Waiting.
- **If it's slow:** approve in the Outbox instead. If the model is slow or fails, the draft says "Written from the fixed template", and that's the safety net working, so say so.

### 4. Delivered (30 seconds)

- **Click:** your second inbox.
- **Say:** "It went from the freelancer's own Gmail, with the PayPal link in it. The same link every time."
- **On screen:** the email, within a minute of approving, if you're inside the send window.
- **If it's slow:** Outbox > Sent shows it went. If it's held for the send window, say "it waits for their working hours", and show it under Scheduled.

### 5. The client replies (75 seconds)

- **Click:** in your second inbox, reply on that thread: `Can I pay half now and half on the 15th?` Run the Reply listener. Open the Outbox.
- **Say:** "The AI reads the reply, but it can only suggest. It can't change an invoice."
- **On screen:** a reply card marked **AI suggestion: Asks to pay in parts**, with 2 × USD 750.00. Set the second date to the coming 15th, then press **Approve split and replace the invoice**.
- **On Telegram:** a card quoting the reply. Run the Scheduler again, and a new draft for installment 1 arrives. Tap **Edit**, send `mention the 15th`, and tap **Approve** on the new card.
- **Click:** **Settings > Demo clock**, enter `22`, and press **Set the clock**. It's due the next morning, so this lets it go.
- **On screen:** the project now shows Installment 1 of 2 and 2 of 2. The email arrives on the same thread, mentioning the 15th.
- **If it's slow:** a local model can take a minute to redraft. Skip the Edit and tap Approve on the first card. If the listener hasn't seen the reply, run it again, or carry on talking: it runs every 5 minutes.

### 6. Installment paid (30 seconds)

- **Click:** on the project, open installment 1's **PayPal pay link**, or use the email's. Pay as the sandbox buyer. Refresh the project.
- **Say:** "Half the money is in, and the app knows who still owes what."
- **On screen:** Build shows **Partially paid**, Paid USD 750.00.
- **If it's slow:** same as step 2. Don't wait on it for long, but step 8's numbers need this payment.

### 7. Switch AI (40 seconds)

- **Click:** **Settings > Demo clock**, and set it to a day past the 15th. Count days from today: for example, if the 15th is 40 days away, enter `41`. Run the Scheduler: a draft for installment 2 appears. Then **Settings > AI**, Provider **Ollama (local)**, model `llama3.2`, **Save AI settings**.
- **On Telegram:** tap **Edit** on the card, and send `make it shorter`.
- **Say:** "Any model, cloud or on your own machine. Client data can stay on this laptop."
- **On screen:** Outbox card says **Drafted by llama3.2**.
- **If it's slow:** `llama3.2` can take a minute, so talk through it, or show Test connection results under Settings > AI instead.

### 8. Close (20 seconds)

- **Click:** Home. Then Clients > Hudson Street Bakery, and scroll to Timeline.
- **Say:** "USD 750 recovered, with every step on record if there's ever a dispute." On days saved, be straight about it: "that's against the 30 days this freelancer says clients usually take. It's their own figure, and for this demo it's made up."
- **On screen:** **Amount recovered** USD 750.00, **Days saved** 15 days, **Typical days late** 15 days, **Recovery rate** 100% (1 of 1), and the Timeline.

## If something goes wrong

| What                              | What to do                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PayPal is slow or its page errors | Move on after 30 seconds. Skipping step 2 costs nothing. Skipping step 6 leaves step 8 with no money to show, so try the pay link again, or close on the Timeline. |
| Telegram is slow or silent        | Do it in the Outbox: Approve, Edit, Skip are all there. If the phone shows "Connecting…", earlier lost taps traced to that.                                        |
| The model is slow or down         | Drafts fall back to the fixed template, and the card says so. Step 7 is safe to skip.                                                                              |
| An email doesn't arrive           | Check the Outbox for "Held". The reason is on the card: outside the send window, Gmail needs reconnecting, or the address isn't in `DEV_EMAIL_ALLOWLIST`.          |
| Something fails badly             | Run `npm run test:e2e` in a terminal, and show the 8 steps pass with fakes. It takes under a minute and doesn't touch your data. Say that's what it is.            |

## Afterwards

1. **Settings > Demo clock**, enter `0`, and press **Set the clock**. Restarting the dev server also resets it, unless `DEMO_CLOCK_OFFSET_DAYS` is set in your env file.
2. To run it again: delete Hudson Street Bakery on its page, skip anything left in the Outbox, then run `npm run db:seed`. Its dates in the database are in the future, so don't keep this data for anything real.
