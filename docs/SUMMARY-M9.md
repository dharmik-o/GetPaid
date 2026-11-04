# M9 summary: Milestone holds

**Holds are built and your three fixes are done, but M9's box stays unticked.** Its Done-when line asks for sandbox tests of capture, reauthorize and void. The sandbox can't authorize unless a buyer approves, and this account refuses the buyer-free card route, so that needs you: `npm run hold:check` is ready. A real reauthorize also needs 4 days to pass, because of PayPal's honor period.

## Your three fixes and M4

| Item | Result | Commit |
| --- | --- | --- |
| Double payment | A failed charge suspends the subscription first, and PayPal must confirm it before any invoice exists. Paying the invoice reactivates it. See "Worth checking" 1. | `412d86d` |
| Dates | Every date in a draft, in any common format, must be in the facts. "May 15, 2027" passes for "15 May 2027". See "Worth checking" 2. | `3bb48eb` |
| Approval link | Auto-pay now makes an email draft with the link as its only link, through normal approval. The link no longer shows on the Retainers screen. | `322416a` |
| M4 | The Done-when line now says Ollama (`llama3.2`), logged, with Claude as an optional item. | `261abb3` |

Each fix had failing tests first. The tunnel stays postponed in `docs/NEEDS_YOU.md`, and expected income is left as built.

## Checks

| Check | Result |
| --- | --- |
| `npm run check` | Green: lint, typecheck and 1665 tests (up from 1428 at the end of M8). No real network calls. |
| Real PayPal sandbox | A hold order with its approval link, a repeated request giving the same order, the refusal to authorize before approval, a JPY order, and capture, reauthorize and void reaching PayPal's API. For auto-pay, activate is confirmed; see "Not run" for suspend. |
| Real local model (`llama3.2`) | 15 of 15 reminders and heads-ups passed the new date checks, with no fallback to the template. The auto-pay email passed 3 of 3, and a hold email passed through the real route. |
| Real browser (Edge) and Postgres | Start hold and Void on a throwaway client, with its rows removed afterwards. The link isn't on the page, and the warning shows for a far deadline. |
| **Your live state, read at 16:01 UTC** | All seven workflows are active. The real reply was read and labelled "promise", and you paused until 6 Nov. Scheduler's first live run succeeded at 16:00. The maintenance card reached Telegram (message 13). |
| **Not run** | Real capture, reauthorize and void, needing a sandbox buyer. Suspend on a real subscription: the sandbox answers 404 for an unapproved one. A real failed charge, which the sandbox can't produce with a valid signature. A hold's PayPal webhooks, live. `next build`, because it shares a folder with your dev server. |

## What was built

**Milestone holds**

- **Start:** on a Planned or In progress milestone, Start hold creates the PayPal order and drafts the email, with PayPal's link as its only link. It warns when the deadline is more than 29 days away.
- **Authorize:** when the client approves, PayPal's own copy is checked, the hold is placed, and you're told on Telegram. The scheduler catches a missed webhook.
- **Capture:** marking the milestone Accepted captures the whole amount, and the money is recorded as a paid invoice. Past day 3 it reauthorizes first. If PayPal refuses that, it still captures while the hold lasts. Past 29 days it doesn't try, and tells you.
- **Failures:** a refused capture keeps the hold and the acceptance, tells you once, and retries each hour with the same request id, so it can't capture twice. A pending capture isn't called paid until PayPal confirms it.
- **Void:** releases the money, at PayPal if it was authorized. A hold voided before approval is never authorized, even if the client approves later.
- **While live:** the milestone's amount and mode are locked, it can't be removed, and the client can't be deleted.
- **After capture:** refunds and disputes are recorded, with refund amounts from PayPal's own copy.

## Worth checking

1. **Double payment: as close to impossible as the app can make it, but one thing isn't proven (please read this one).** PayPal's docs say a paused subscription stops processing payments, and that's what this rests on. They don't say whether a retry resumes after reactivation, and the sandbox can't produce a real failed charge to find out. If one did, the client would have paid twice, and the app would warn you to refund. The "may have paid twice" warning stays as that backstop, and for a charge already under way when the suspension lands.
2. **One exception to your date rule (please check this one).** You said to reject any date not in the facts. I allow a date you typed in a Telegram edit, for that redraft. Your spec's own example is "mention the 15th", and strict checking would refuse it. A date already in a draft can also stay through a hand edit. A new date typed in the Outbox is refused. "Today" and "next Friday" count as dates. Tell me if you want this tightened.
3. **Charge dates during an auto-pay pause aren't billed (your call).** A client who takes two months to pay the catch-up invoice skips those months unless you act. I didn't invoice them, because PayPal's docs don't rule out billing missed cycles on reactivation, which could charge twice. The alert tells you to check.
4. **A gap in an older check.** The model wrote "$200.00" for "USD 200.00". Amounts are compared by number, not currency, so "$200.00" would also pass for "EUR 200.00". You'd still see it before approving. It's a small fix if you want it.
5. **Auto-accept isn't built.** The spec allows it only if the contract says so, and there's no field for that. A hold is captured only when you mark it Accepted.
6. **The Project page overflows on a phone by 617 pixels.** It's the milestone table from M2, not the new panel. Accepting a milestone is on that table, so it's worth fixing. I left it out as unrelated, and can do it next.
7. **Approval email wording.** The local model wrote clumsy lines such as "until we approve". The checks test facts, not style, so read these before approving.

## Mistakes to flag

- **My edit script ran partly, then again.** While building the approval email it stopped midway, and re-running it doubled some edits in uncommitted files. I restored those files and applied it once, and nothing wrong was committed. While it lasted, your running dev server may have shown errors for a few minutes, around the time of your live checks. If something failed oddly around then, that's why.
- **M8's retry check was wrong.** It treated "nothing outstanding" as meaning PayPal's retry had won. PayPal's docs say a failed charge only reaches that balance after its retries run out, so during the retry window that check could have cancelled an invoice still owed, had a later payment arrived. No real failed charge ever reached it. It now compares the last payment and last failure times.

## What I did on your n8n and database

- Nothing on n8n: you ran the go-live. I read its run history and left no files in the container.
- Applied migrations 019, 020 and 021 to your local database as each change landed, so your dev server kept working.

## Needs you

All of this is in `docs/NEEDS_YOU.md`.

1. **Run `npm run hold:check`,** then `-- keep`, and the reauthorize 4 days on. That decides M9's box.
2. **Your live checks:** the maintenance card is on your phone now. Skip, Edit with typed text and auto-pay approval are still open. Auto-pay works differently now: look for the draft in the Outbox.
3. **After a buyer approves an auto-pay,** leave it running and tell me, and I'll run a real suspend and reactivate.
4. **Your calls:** charge dates during a pause, the date exception, the currency check, and auto-accept.
5. **Postponed or optional:** the fixed tunnel, and Test connection with Claude.
6. **Still open from earlier:** the wording for the laws in `legal/statutes.json`, and sign-in before deployment.

## Next

M10: dashboard and demo.
