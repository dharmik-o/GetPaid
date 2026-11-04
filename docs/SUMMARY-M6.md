# M6 summary: Approvals

**All four M6 items are ticked, and approvals work in the Outbox and through the app's Telegram side. Real Telegram hasn't run yet: that needs a bot only you can create.** Approving records the decision. Nothing is sent yet, because the sender is M7.

## Checks

| Check                            | Result                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                  | Green: lint, typecheck and 999 tests (up from 860 at the end of M5). No real network calls.                                                                                                                                          |
| Real browser (Edge) and Postgres | The Outbox on desktop and phone; Connect Telegram; approving, skipping, editing and rescheduling; a relayed Telegram approval moving the open Outbox on its own after 9 seconds. Fake rows and throwaway values, removed afterwards. |
| Real local model                 | A plain-word redraft through your Ollama `llama3.2` passed the checks.                                                                                                                                                               |
| n8n                              | `03_approval_handler` imports (inactive).                                                                                                                                                                                            |
| **Not run**                      | The workflow's Telegram nodes against real Telegram. I wrote their settings by hand, so the first live card is what proves them.                                                                                                     |

The `Done when` list is covered in `tests/api/telegram-sync.test.ts`: approving in each place, a double approve, a foreign chat ID and the timeout.

## What was built

**Outbox page** (`3f851e0`, fixed in `22a3adf`)

- Tabs for Waiting, Scheduled, Sent and Skipped, with a count badge in the sidebar.
- Each card shows the client, amount, tier, the full message with its pay link, and the send time in both zones.
- Approve, Edit, Skip and Reschedule. An approved draft that hasn't gone out can still be moved or stopped.
- Your own time zone is new, in Settings (migration 010).

**Connect Telegram** (`0f6c560`)

- Settings > Integrations makes a one-time link that lasts 15 minutes and works once. Only its hash is stored.
- Group chats, and chats linked to another account, are refused. You can disconnect.
- The bot token stays in n8n, so the app never holds it.

**Telegram cards** (`7de2675`)

- Cards with Approve, Edit and Skip. Buttons use the Outbox's own checks.
- A plain-word edit is quoted to the AI as data. The answer passes the usual checks and still waits for approval, and if no model gives a good one, the draft stays as it was.
- Drafts over 4096 characters are sent as a preview with a pointer to the Outbox.

**Sync** (`73ee1b9`)

- A draft handled in one place expires in the other, including when a payment stops it.
- One nudge after 24 hours (editable), then held. It's never sent on its own.
- Taps from other chats are ignored.

## Worth checking

1. **Editing is stricter than you might expect.** Your own edits pass the same checks as the AI's, so you can't add a second link, an amount that isn't on the invoice, or legal or fee wording. I chose that to keep wrong amounts and invented laws out of emails. Tell me if it's too strict for your own wording.
2. **One rule beyond the spec.** A card's buttons work only while it shows the current wording, so nobody approves text they weren't shown. A change in the dashboard replaces the card.
3. **One spec detail changed.** The spec named n8n's send-and-wait node. The app now decides and n8n only sends, so Telegram and the Outbox share one set of checks. Spec updated.
4. **Wording for now.** The bot says "Approved. Sends <time>", not the spec's "Sent at", because nothing has been sent at that point. M7 should confirm the real send.

## Mistakes I made

- **A bug in the first Outbox commit:** an edited draft could only be skipped, because the edit saved an extra field and failed the schema. It failed closed, so nothing unsafe could go out. The sync tests caught it, and it has its own fix and test.
- **A commit on a red check:** the Connect Telegram commit first went in with one failing test, because my command didn't make the commit depend on the check. I amended it before moving on, and every commit since has depended on the check passing.

## Needs you

All of this is in `docs/NEEDS_YOU.md`.

- **New:** create the Telegram bot, and start a tunnel for n8n. Steps are there, and the first real tap is what signs off the workflow's Telegram nodes.
- **Still open from earlier:** `INTERNAL_API_TOKEN` and its n8n credential (Telegram needs this too), the live PayPal webhook tunnel, the laws for `legal/statutes.json`, sign-in before deployment, the Playwright browser, and the by-hand M4 Test connection, which is still unticked. Your Ollama model now answers real drafts, so only that run and the Claude one remain.
- **For you to know:** two of my commands were refused and I didn't route around either. Neither blocks anything.

## Next

M7: the sender (Gmail on the original thread, approved drafts only, inside the send window) and the reply listener. Gmail needs your OAuth client.
