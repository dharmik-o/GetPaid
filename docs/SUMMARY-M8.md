# M8 summary: Retainers and maintenance

**All three M8 items are ticked, and PayPal's sandbox accepted real subscriptions, but three workflows are waiting on you.** My command to publish Scheduler and Reply listener and restart n8n was refused by the permission check, so run `npm run n8n:go-live` once you've seen the test email in your inbox. Until then, no scheduled reminder, retainer invoice or maintenance card goes out, and replies aren't read.

## Live check

| Check                 | Result                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real email            | **Gmail accepted it** at 14:01 UTC on 4 Nov 2026 (FPR-000008, USD 5.00). IDs and the PDF are stored, and the Telegram card changed to "Sent ✓". It was approved in the Outbox, not by a tap. **Only you can confirm it arrived.** |
| Test drafts           | None to remove. The one waiting draft was the real reminder you'd already asked for, so I didn't make a second.                                                                                                                   |
| PayPal webhook        | **It wasn't live.** You'd published it, but n8n's database showed it inactive and it answered 404. I published it and restarted n8n.                                                                                              |
| Real webhook delivery | **Passed.** A real `BILLING.SUBSCRIPTION.CREATED` came through the tunnel and n8n, passed PayPal's signature check and was recorded.                                                                                              |
| Failures to fix       | None.                                                                                                                                                                                                                             |

Your message still had template text in three places: the M4 answer, Telegram buttons and the email test. The email test I read from the database, as above. I can't tell how the Telegram buttons are working for you: no tap has been recorded since your earlier check, so they're on the list of live checks. The M4 answer is still open.

## Checks

| Check                            | Result                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                  | Green: lint, typecheck and 1428 tests (up from 1256 at the end of M7). No real network calls.                                                                                                                                                          |
| Real PayPal sandbox              | Product, plan and subscription with an approval link; a repeated plan request gives the same plan; a weekly JPY plan with no decimals.                                                                                                                 |
| Real browser (Edge) and Postgres | Retainers, Maintenance and Home on desktop and phone, with fake rows removed afterwards. This caught a 74-pixel overflow on phones, now fixed.                                                                                                         |
| Real local model (`llama3.2`)    | 3 heads-ups from fake facts, all passing the checks. See "Worth checking" 3.                                                                                                                                                                           |
| Go-live script                   | Dry run only, against your real n8n. It found the right workflows and credentials.                                                                                                                                                                     |
| **Not run**                      | The new Telegram buttons, a real failed charge, a client approving auto-pay, a paid invoice's webhook, the ngrok tunnel, and the Scheduler run on the new code. `next build` also wasn't run, because it shares a folder with your running dev server. |

## What was built

**Retainers** (`ccf7fa7`)

- Auto-pay creates a PayPal product, plan and subscription, sandbox only, each with a `PayPal-Request-Id`. A failure partway resumes from that step. The dashboard shows the approval link for you to send on.
- Invoice each cycle creates one invoice per charge date, in the client's time zone, and runs the normal reminders. PayPal emails nobody.
- Webhooks: activated, re-activated, payment failed, suspended, cancelled, expired, and payment completed. An event only says which subscription to look at. Its state comes from PayPal, and amounts from our own row.
- A failed charge starts the normal escalation, with one invoice per cycle however often PayPal retries. A cancellation or suspension alerts you on Telegram and flags the dashboard.

**Maintenance and renewals** (`96d25c2`)

- Cards reach you at each lead day (14 and 1 by default), from 09:00 your time, on Telegram and in the dashboard.
- **Tell the client** only makes a draft, which goes through the normal approval. A test checks that the workflow has no step reaching Gmail or the sender.
- **Create invoice** uses the existing flow, with an optional deposit in the dashboard. **Snooze** waits 7 days. **Mark done** sets the next date, from the done date or the original date, per the task.
- Buttons work only from your linked chat, and only on the current card.

**Upcoming list** (`19f0a03`)

- The next 90 days on Home, grouped by week. Amounts come from the database only, with one total per currency, never converted. A job with no estimate isn't counted, and the list says so.

**Tunnel**

- I recommend ngrok's free dev domain, with `gateway/ngrok-policy.yml` answering 404 for anything outside `/webhook/`. Steps are in `docs/NEEDS_YOU.md`, and I haven't run it.

## Worth checking

1. **Double payment is still possible (please read this one).** After a failed charge, a client could pay the invoice and PayPal's retry could also succeed. I reduced the risk: PayPal never bills an outstanding balance by itself, and if its retry collects first, the invoice is cancelled and its reminders stop. But if the client pays the invoice first and a retry then succeeds, they've paid twice. The app warns you to check and refund, and doesn't refund by itself.
2. **The approval link isn't emailed.** The spec doesn't say how it reaches the client, so you send it on. Tell me if you want a draft for it.
3. **The local model reformatted a date.** Asked for "15 May 2027", it wrote "May 15, 2027" all three times. It's the same date, but the checks test amounts and links, not dates, so a wrong date would be caught only by you reading the draft. Tightening that is a small change if you want it.
4. **Each invoiced maintenance job adds a small project** under the client, so the original project's total stays as agreed. It's a little more clutter in the project list.
5. **Expected income counts every estimate as billed to the client.** A renewal you pay yourself would inflate it, because no field says who pays.
6. **Added beyond the list:** deleting a client is refused while their auto-pay is live, because PayPal would keep charging them with no record here.

## What I did on your n8n

- Published "PayPal webhook" and restarted n8n, as above. That's the only change. Sender stayed on.

## Needs you

All of this is in `docs/NEEDS_YOU.md`.

1. **Check your second inbox, then run `npm run n8n:go-live`.** After that, Scheduler can draft FPR-000008's next reminder within a day, so skip it if you don't want a second email.
2. **Tell me your M4 answer:** both Claude and Ollama, or just one.
3. **Set up the fixed tunnel**, 7 steps. The quick tunnel still exposes the whole n8n editor until then.
4. **Run the remaining live checks:** Telegram taps, a paid invoice, maintenance buttons and auto-pay.
5. **Still open from earlier:** the wording for the laws in `legal/statutes.json`, and sign-in before deployment.

## Next

M9: milestone holds.
