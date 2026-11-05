# Video script

A demo of 2 minutes 50 seconds, based on the 8 demo steps. That leaves 10 seconds of margin under the 3-minute limit.

The live demo in `docs/DEMO.md` takes about 5 minutes, mostly waiting for models, webhooks and the clock. So record each scene separately, cut the waiting, and read the voiceover over the edit. Cutting a wait is fine, but don't fake a result: every screen should come from a real run.

## Before you record

1. **Follow "Before you start" in `docs/DEMO.md`,** including the clean slate. That's 20 minutes, and it covers the services, the tunnel, Gmail, Telegram and the sandbox buyer.
2. **Rehearse the whole run once.** It hasn't yet been run live as one piece, and steps 2, 3, 4 and 6 are only proven end to end by doing this.
3. **Run Test connection with Claude.** So far it has only run by hand with `llama3.2`. If you don't use Claude, draft with `llama3.2` in scene 4, change "Claude" in that scene's voiceover to the model you used, and make scene 8 switch to or from whichever model you have.
4. **Check the send window.** Emails go out from 9:00 to 17:00 New York time. If you're recording outside it, add part of a day to each clock jump, as `docs/DEMO.md` explains.
5. **Set up the screen.** Use a 1280 × 720 browser window at 125% zoom, and clear personal tabs and bookmarks. Blur or avoid showing real email addresses, and never show your env file, keys or the sandbox account's password.
6. **Check the hackathon's rules** for where the video must be hosted and anything it must show.

## The script

Speak at a relaxed pace, about 2.4 words a second. Each scene's voiceover fits its time at that pace.

### Scene 1: The problem (0:00 to 0:12)

- **Screen:** `/welcome`. The hero plays: the invoice slides in, Sent turns to Paid, and the stamp lands. Then scroll slowly to How it works.
- **Voiceover:** "Freelancers working across borders do the work, then spend weeks chasing the money. GetPaid protects payment up front, and chases it for you, politely."

### Scene 2: Set up (0:12 to 0:26)

- **Demo step:** 1
- **Screen:** press Open dashboard, then Projects > Website redesign. Show the three milestones and the schedule line under Summary.
- **Caption:** PayPal sandbox
- **Voiceover:** "A freelancer in India, a client in New York. Three thousand dollars across three milestones. Net seven, a reminder every three days, and only in the client's working hours."

### Scene 3: Deposit (0:26 to 0:46)

- **Demo step:** 2
- **Screen:** on the Design row under Bill your milestones, type `900.00` and press Create deposit invoice. Open the PayPal pay link and pay as the sandbox buyer. Cut the wait, then refresh: Design shows Paid and the stamp lands.
- **Voiceover:** "The deposit protects the freelancer before work starts. The client pays on a real PayPal invoice, in the sandbox. PayPal's signed webhook marks it paid. The app takes PayPal's word for it, not the client's."

### Scene 4: Overdue (0:46 to 1:16)

- **Demo step:** 3
- **Screen:**
  1. Mark Build delivered, then press Create invoice.
  2. Go to Settings > Demo clock, enter `21`, and press Set the clock. The banner appears.
  3. Run the Scheduler (cut the wait), and open the Outbox.
  4. Show the Tier 2 draft for USD 1,500.00, with both time zones.
  5. Cut to your phone: the Telegram card. Tap Approve.
  6. Back in the Outbox, the card leaves Waiting by itself.
- **Caption:** Demo clock: 21 days ahead
- **Voiceover:** "Now we jump the clock three weeks, and nobody's paid. Build is fourteen days overdue. Claude drafts a firmer reminder, citing the agreed terms. But nothing goes out until the freelancer approves it. The same draft is in the Outbox and on Telegram on my phone. One tap, and the dashboard updates by itself."

### Scene 5: Delivered (1:16 to 1:26)

- **Demo step:** 4
- **Screen:** the client's inbox. Open the email, and hover over the PayPal link.
- **Voiceover:** "It lands from the freelancer's own Gmail, inside the client's working hours, with the same PayPal link every time."

### Scene 6: The client replies (1:26 to 2:00)

- **Demo step:** 5
- **Screen:**
  1. In the client's inbox, reply: `Can I pay half now and half on the 15th?`
  2. Run the Reply listener (cut the wait), and open the Outbox.
  3. Show the card: AI suggestion: Asks to pay in parts, 2 × USD 750.00. Set the second date to the coming 15th, and press Approve split and replace the invoice.
  4. On the project, show Installment 1 of 2 and 2 of 2.
  5. On Telegram, tap Edit on the new draft, send `mention the 15th`, and approve the redraft (cut the wait).
  6. In the inbox, show the email on the same thread, mentioning the 15th.
- **Voiceover:** "The client replies, asking to split it. That pauses the reminders. The AI reads the reply and suggests two installments, but it can only suggest. It can't change an invoice, whatever an email says. I approve, and the invoice is replaced by two separate PayPal invoices, each with its own due date. I ask for a change in plain words on Telegram, and it goes out on the same thread."

### Scene 7: Installment paid (2:00 to 2:14)

- **Demo step:** 6
- **Screen:** open installment 1's pay link and pay as the sandbox buyer. Cut the wait, then refresh the project: Build shows Partially paid, Paid USD 750.00.
- **Voiceover:** "The client pays the first installment. The milestone turns partially paid, and the next reminder is only for the second one, on the fifteenth."

### Scene 8: Switch AI (2:14 to 2:32)

- **Demo step:** 7
- **Screen:**
  1. Set the demo clock to a day past the 15th, and run the Scheduler (cut the wait).
  2. Go to Settings > AI, pick Ollama (local), enter `llama3.2`, and press Save AI settings.
  3. On Telegram, tap Edit and send `make it shorter` (cut the wait).
  4. In the Outbox, show the card: Drafted by llama3.2.
- **Voiceover:** "Any model works: Claude, OpenAI, Gemini, or one running on your own laptop. I switch to a local Ollama model and redraft. Now client emails never leave this machine. If a model ever fails, a fixed template takes over."

### Scene 9: Close (2:32 to 2:50)

- **Demo step:** 8
- **Screen:** Home, showing Amount recovered USD 750.00, Days saved 15 days and Recovery rate 100%. Then Clients > Hudson Street Bakery, and scroll the Timeline. End on the GetPaid logo and the repo's address.
- **Caption over Days saved:** Compared with the freelancer's own figure. Demo data.
- **Voiceover:** "The dashboard shows what was recovered, compared with how late this freelancer says clients usually pay. Every step is on record if there's ever a dispute. You did the work. GetPaid gets you paid for it, and you stay in charge of every message."

## If something won't work on the day

| What                                            | What to do                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sandbox payment or webhook won't come through | Retry on a new take. If a payment never registers, you have no scene 7 or real numbers for scene 9, so don't show those numbers. Fix it or close on the Timeline. |
| Telegram is silent                              | Approve in the Outbox, and change "on my phone" and "on Telegram" in the voiceover to match.                                                                      |
| The model draft fails                           | The card says "Written from the fixed template". Show it, and say it's the safety net working. Don't credit Claude for it.                                        |
| The video runs long                             | Cut the Telegram edit from scene 6 first, then the clock and Scheduler part of scene 8.                                                                           |
