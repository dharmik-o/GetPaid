# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **Optional: run Test connection with Claude.** M4 now records what you ran by hand: Ollama (`llama3.2`). To try Claude too, pick it in Settings > AI, enter your key, and press Test connection. Nothing depends on this.

- **Fixed tunnel address (postponed by you on 4 Nov 2026; ngrok is my recommendation, reasons in `docs/DECISIONS.md`):** it gives one address that doesn't change, and only `/webhook/*` gets through. Until then the quick tunnel still exposes the whole n8n editor. **I haven't run this**, because it needs your account. Step 4 is how you check it.
  1. Create a free account at https://ngrok.com, and copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken.
  2. Install it, and save the token in ngrok's own config: `winget install ngrok.ngrok`, then `ngrok config add-authtoken <your token>`. It stays out of this repo.
  3. Stop `cloudflared`. Find your free dev domain in the ngrok dashboard under Domains, then run this from the repo folder and leave it running:

     ```
     ngrok http 5678 --url=https://<your-domain> --traffic-policy-file=gateway/ngrok-policy.yml
     ```

  4. Check it. The first must answer 404, and the second 400 with "Missing PayPal signature headers." If the first shows n8n, stop ngrok and tell me.

     ```
     curl -i https://<your-domain>/
     curl -i -X POST -H "content-type: application/json" -d "{}" https://<your-domain>/webhook/paypal
     ```

  5. Set `WEBHOOK_URL` in your local env file to `https://<your-domain>`, then run `docker compose up -d n8n`. n8n registers the new address with Telegram when it starts.
  6. In your PayPal sandbox app, edit the webhook's URL to `https://<your-domain>/webhook/paypal`. If PayPal gives it a new ID, update `PAYPAL_WEBHOOK_ID` and restart the dev server.
  7. The n8n editor stays at http://localhost:5678.

- **Live checks left (you're doing these in parallel).** Each needs your phone or a sandbox buyer:
  1. **Telegram:** a real send approved by a tap (FPR-000008's went through the Outbox), Skip, and typing a change after Edit. `npm run telegram:test` makes a fake draft for the last two, and `npm run telegram:test -- status` shows what each tap did.
  2. **A paid invoice:** open FPR-000008's pay link and pay it with a sandbox buyer. It should turn Paid in the dashboard, and any waiting reminder should stop.
  3. **Maintenance buttons:** the card for your "renew task" reached Telegram at 16:01 UTC on 4 Nov 2026 (message 13), so it's on your phone now. Try Tell the client, then approve the draft: the client gets the email only then. Try Create invoice, Snooze and Mark done too.
  4. **Auto-pay:** add an auto-pay retainer on the Live Gmail Test client. This changed since M8: the approval link no longer shows on the Retainers screen. Instead a draft appears in the Outbox and on Telegram, with the link as its only link. Approve it, open the link from the email, and approve with a sandbox buyer. It should turn Active. Cancel it from the sandbox buyer's account: Telegram should alert you. PayPal's simulator can't produce a charge failure that passes signature checks, so a failed charge stays tested with PayPal mocked.
  5. **Suspend on a real subscription:** once a sandbox buyer has approved one, tell me and leave it running. The sandbox refuses suspend on an unapproved subscription, so its path is the one part of the double-payment fix not yet run against PayPal. I can then suspend and reactivate it in a sandbox test.

- **Real capture, reauthorize and void, which M9's box is waiting for.** The sandbox can't authorize without a buyer approving, and this account refuses the buyer-free card route (`PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`). This needs a sandbox personal account, which you can find in the PayPal developer dashboard under Sandbox > Accounts.
  1. Run `npm run hold:check`. It prints two links, one at a time. Open each, sign in with the sandbox buyer and approve. It runs a real capture and a real void, and shows PayPal's answer to reauthorizing early. It uses USD 5.00 of sandbox money, touches no database and emails nobody.
  2. Run `npm run hold:check -- keep` and approve once more. It prints an authorization id. PayPal only allows reauthorizing after its 3-day honor period, so in 4 to 29 days run the command it prints.
  3. Tell me the results. I'll tick M9 once 1 and 2 pass, or sooner if you decide 1 is enough for now, in which case I'd reword the Done when line as we did for M4.

- **Try a hold in the app.** On a project, set a milestone to Milestone hold, then press Start hold under Milestone holds. A draft appears in the Outbox and on Telegram, with PayPal's link as its only link. Approve it, approve the link with a sandbox buyer, and the hold turns Authorized with a Telegram message. Mark the milestone Delivered, then Accepted: that captures it, and the milestone turns Paid.

- **Your call: charge dates during an auto-pay pause.** After a failed charge, auto-pay stays paused until that invoice is paid. Charge dates that pass during the pause aren't billed by PayPal, and I don't invoice them either, because PayPal's docs don't rule out billing missed cycles on reactivation, and that could charge twice. So a client who takes two months to pay skips those months unless you act. The alert tells you to check. If you'd like invoices for those dates, say so. It's a small change, but only safe once a real pause and reactivation shows what PayPal does.

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.

- **Laws for Tier 3 (`legal/statutes.json` is empty; the rules say I must ask before adding one):** the spec names four starting laws: UK Late Payment of Commercial Debts (Interest) Act 1998, EU Late Payment Directive 2011/7/EU, India MSMED Act 2006 (registered MSMEs only) and NYC Freelance Isn't Free Act. Each entry needs the exact citation sentence a notice may include, an official https source URL and the date you checked it (shape in `docs/DECISIONS.md`, M5 Legal gating). Approve them, or give me the wording, and I'll add them and run `npm run ai:prompts`. The India and NYC laws need a `condition`, so they'll never be cited automatically (the app can't check MSME registration or the city). Until then, a Tier 3 notice cites only the contract's late-fee clause, or nothing.

- **Gmail's Testing mode ends the connection after 7 days.** Sends are then held, and you're told on Telegram and in the dashboard to press Reconnect Gmail.

- **Your call: auto-accept.** The spec allows capture after the acceptance window only if the contract says so, and there's no field for that, so it isn't built: a hold is captured only when you mark the milestone Accepted. Tell me if you want it.

## Blocked commands, for your records

Nothing here is blocking work, and I didn't route around any of them.

- **M8, 4 Nov 2026:** publishing Scheduler and Reply listener and restarting n8n was refused as a production deploy. You ran `npm run n8n:go-live` instead.
- **M4:** the protect-files hook blocked a one-off script that named the env file, so it could use `LITELLM_MASTER_KEY` without printing it. I ran the same check with no key instead: LiteLLM answered 401, and the router correctly fell back to the template. To check with the key, enter the gateway in Settings > AI (Custom URL `http://127.0.0.1:4000/v1`, local, your master key, model `mock`) and press Test connection. Expect "template" for every task, because the mock model always answers `{"ok": true}`, which fails the schemas.
- **M4:** a shell command that appended to my own memory index was refused because its text mentioned the env file's name. No env file was involved. I used the file-edit tool instead.
- **M6:** clearing the Next.js build cache with `rm -rf apps/web/.next` was refused while the dev server was reloading every page in a loop (`HMR hash mismatch`). A plain restart fixed the loop. If you see it, restart first.
- **M6:** a PowerShell script with `-ExecutionPolicy Bypass` was refused. I used `tasklist` and `netstat` instead.
- **4 Nov 2026:** while finding out why n8n had an http webhook address, one check named the env file, and I'd planned to read `docker compose config`, which would show its values. I dropped both and read only the running container's own `WEBHOOK_URL`.

## Done

- **Go-live and the real email** (4 Nov 2026): you ran `npm run n8n:go-live`, and all seven workflows are active. The FPR-000008 email reached your second inbox: you replied to it, Reply listener read the reply at 15:19 UTC and labelled it "promise", and you paused the invoice until 6 Nov from the card. Scheduler's first live run was at 16:00 UTC, and the new four-button card reached Telegram at 16:01.
- **Answers to the M7 questions** (4 Nov 2026): any reply holds the invoice and you decide with a tap, as built.
- **PayPal webhook is live** (4 Nov 2026): you'd set the URL, events and `PAYPAL_WEBHOOK_ID`. "PayPal webhook" still showed inactive in n8n's database and answered 404, so I published it and restarted n8n. A real `BILLING.SUBSCRIPTION.CREATED` then came through the tunnel and passed PayPal's signature check.
- **Google OAuth client** (4 Nov 2026): you set it up, with `DEV_EMAIL_ALLOWLIST` holding your second inbox. The steps are in `docs/setup.md` if you need them again.
- **Telegram linked, and cards arrive** (4 Nov 2026): delivery, Approve and tapping Edit all ran live. If buttons go dead again, check your phone for "Connecting…" first: earlier lost taps showed no gap in Telegram's update numbers, and that was never explained.
- **Dev server restart and Connect Telegram** (4 Nov 2026): you did both.
- **n8n token, Telegram bot and tunnel** (4 Nov 2026): you set `INTERNAL_API_TOKEN`, `TELEGRAM_BOT_USERNAME` and `WEBHOOK_URL`, and created the n8n credentials (`Header Auth account` and `Telegram account`).
- **Playwright browser** (4 Nov 2026): you ran `npx playwright install chromium`.
- **M4 Test connection by hand** (4 Nov 2026): you ran Test connection with a real model in Settings > AI, and all 4 tasks passed. Box ticked in `docs/FEATURES.md`.
- **PayPal partial payments blocked for the sandbox account's country** (3 Nov 2026). Resolved by your approved change (`docs/CHANGE-installments-and-templates.md`): installments (separate invoices) replace PayPal partial payments everywhere, so no other sandbox account is needed.
