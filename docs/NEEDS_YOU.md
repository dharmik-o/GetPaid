# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **1. Check the real email arrived, then go live.** FPR-000008's reminder was approved in the Outbox at 14:00 UTC on 4 Nov 2026, and Gmail accepted it at 14:01: the message and thread IDs are stored, the PDF was made, and the Telegram card changed to "Sent ✓". I can't see your inbox. If it's there, with its pay link and PDF, the live check has passed, so run this from the repo folder:

  ```
  npm run n8n:go-live
  ```

  It updates "Approval handler" (it needs the maintenance card), publishes it, "Scheduler" and "Reply listener", and restarts n8n. `npm run n8n:go-live -- --dry-run` shows the plan and changes nothing: I ran that, and it found the right workflows and credentials.

  **Why you and not me:** the permission check refused my command to publish those workflows and restart n8n, classing it as a production deploy, so I stopped and didn't retry it another way (rule 10). An earlier publish of "PayPal webhook" in the same session had gone through.

  **What to expect:** Scheduler starts real AI drafts, so FPR-000008's next reminder (Tier 1) can arrive as a new card within a day. Skip it if you don't want a second email. Once Reply listener is on, reply from your second inbox to test reading a real reply.

- **2. Your M4 answer didn't come through.** Your message still had the template text (`<"I ran both Claude and Ollama" or "I ran only <model>...">`). The `Done when` line says "Claude plus Ollama by hand", and your earlier note says "a real model". Tell me which you ran. If only one, I'll reword the line. I've changed nothing.

- **3. Fixed tunnel address (ngrok, my recommendation; reasons in `docs/DECISIONS.md`):** it gives one address that doesn't change, and only `/webhook/*` gets through. **I haven't run this**, because it needs your account. Step 4 is how you check it.
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

- **4. Live checks left, once item 1 is done.** Each needs your phone or a sandbox buyer:
  1. **Telegram:** a real send approved by a tap (FPR-000008's went through the Outbox), Skip, and typing a change after Edit. `npm run telegram:test` makes a fake draft for the last two, and `npm run telegram:test -- status` shows what each tap did.
  2. **A paid invoice:** open FPR-000008's pay link and pay it with a sandbox buyer. It should turn Paid in the dashboard, and any waiting reminder should stop.
  3. **Maintenance buttons:** add a job on the Live Gmail test project, due within 14 days. After 09:00 your time, the next Scheduler run sends a card. Try Tell the client, then approve the draft: the client gets the email only then. Try Create invoice, Snooze and Mark done too.
  4. **Auto-pay:** add an auto-pay retainer on the Live Gmail Test client, then open its approval link and approve with a sandbox buyer. It should turn Active. Cancel it from the sandbox buyer's account: Telegram should alert you. PayPal's simulator can't produce a charge failure that passes signature checks, so a failed charge stays tested with PayPal mocked.

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.

- **Laws for Tier 3 (`legal/statutes.json` is empty; the rules say I must ask before adding one):** the spec names four starting laws: UK Late Payment of Commercial Debts (Interest) Act 1998, EU Late Payment Directive 2011/7/EU, India MSMED Act 2006 (registered MSMEs only) and NYC Freelance Isn't Free Act. Each entry needs the exact citation sentence a notice may include, an official https source URL and the date you checked it (shape in `docs/DECISIONS.md`, M5 Legal gating). Approve them, or give me the wording, and I'll add them and run `npm run ai:prompts`. The India and NYC laws need a `condition`, so they'll never be cited automatically (the app can't check MSME registration or the city). Until then, a Tier 3 notice cites only the contract's late-fee clause, or nothing.

- **Gmail's Testing mode ends the connection after 7 days.** Sends are then held, and you're told on Telegram and in the dashboard to press Reconnect Gmail.

## Blocked commands, for your records

Nothing here is blocking work, and I didn't route around any of them.

- **M8, 4 Nov 2026:** publishing Scheduler and Reply listener and restarting n8n was refused as a production deploy (item 1 above).
- **M4:** the protect-files hook blocked a one-off script that named the env file, so it could use `LITELLM_MASTER_KEY` without printing it. I ran the same check with no key instead: LiteLLM answered 401, and the router correctly fell back to the template. To check with the key, enter the gateway in Settings > AI (Custom URL `http://127.0.0.1:4000/v1`, local, your master key, model `mock`) and press Test connection. Expect "template" for every task, because the mock model always answers `{"ok": true}`, which fails the schemas.
- **M4:** a shell command that appended to my own memory index was refused because its text mentioned the env file's name. No env file was involved. I used the file-edit tool instead.
- **M6:** clearing the Next.js build cache with `rm -rf apps/web/.next` was refused while the dev server was reloading every page in a loop (`HMR hash mismatch`). A plain restart fixed the loop. If you see it, restart first.
- **M6:** a PowerShell script with `-ExecutionPolicy Bypass` was refused. I used `tasklist` and `netstat` instead.
- **4 Nov 2026:** while finding out why n8n had an http webhook address, one check named the env file, and I'd planned to read `docker compose config`, which would show its values. I dropped both and read only the running container's own `WEBHOOK_URL`.

## Done

- **Answers to the M7 questions** (4 Nov 2026): any reply holds the invoice and you decide with a tap, as built. Publish the remaining workflows once the live check passes (item 1).
- **PayPal webhook is live** (4 Nov 2026): you'd set the URL, events and `PAYPAL_WEBHOOK_ID`. "PayPal webhook" still showed inactive in n8n's database and answered 404, so I published it and restarted n8n. A real `BILLING.SUBSCRIPTION.CREATED` then came through the tunnel and passed PayPal's signature check.
- **Gmail connected and the first real send** (4 Nov 2026): see item 1 for what's left to confirm.
- **Google OAuth client** (4 Nov 2026): you set it up, with `DEV_EMAIL_ALLOWLIST` holding your second inbox. The steps are in `docs/setup.md` if you need them again.
- **Telegram linked, and cards arrive** (4 Nov 2026): delivery, Approve and tapping Edit all ran live. If buttons go dead again, check your phone for "Connecting…" first: earlier lost taps showed no gap in Telegram's update numbers, and that was never explained.
- **Dev server restart and Connect Telegram** (4 Nov 2026): you did both.
- **n8n token, Telegram bot and tunnel** (4 Nov 2026): you set `INTERNAL_API_TOKEN`, `TELEGRAM_BOT_USERNAME` and `WEBHOOK_URL`, and created the n8n credentials (`Header Auth account` and `Telegram account`).
- **Playwright browser** (4 Nov 2026): you ran `npx playwright install chromium`.
- **M4 Test connection by hand** (4 Nov 2026): you ran Test connection with a real model in Settings > AI, and all 4 tasks passed. Box ticked in `docs/FEATURES.md`.
- **PayPal partial payments blocked for the sandbox account's country** (3 Nov 2026). Resolved by your approved change (`docs/CHANGE-installments-and-templates.md`): installments (separate invoices) replace PayPal partial payments everywhere, so no other sandbox account is needed.
