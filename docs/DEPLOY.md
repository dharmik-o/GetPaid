# Deploying the public demo (Oracle Cloud, free)

This puts the app on a free server with a free HTTPS address, so judges and friends can open a link. It runs the sandbox only: payments are PayPal sandbox, and emails go only to the address you list. Anyone with the link sees a password page first.

Plan for about two hours the first time, most of it waiting for the VM and the first build. You need: an Oracle Cloud account (a card is needed to verify who you are), a GitHub or Google login for DuckDNS, and the keys you already use on your laptop (PayPal sandbox app, Telegram bot, Google OAuth client, one AI key).

```
Browser ──https──> Caddy (ports 80, 443) ──> web app      (everything, behind the demo password)
                         └── /webhook/* ──> n8n           (Telegram and PayPal webhooks)
n8n editor, Postgres, Ollama, LiteLLM: never reachable from the internet
```

## 1. Create the server

1. Sign up at **oracle.com/cloud/free**. Pick a **home region** near you (Mumbai or Hyderabad). You can't change it later, and Always Free resources only exist there.
2. **Compute > Instances > Create instance:**
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build).
   - Shape: **VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory**. Oracle cut the Always Free Arm allowance to 2 OCPUs and 12 GB in mid-2026, and some guides still say 4 and 24. Staying at 2 and 12 keeps it free.
   - Boot volume: 100 GB (the free allowance is 200 GB in total).
   - Add your SSH public key.
   - "Out of capacity" is common. Try another availability domain, or try again later.
3. **Reserve the public IP** (Networking > Reserved public IPs) and attach it, so the address never changes.
4. **Open ports 80 and 443 in the cloud network:** Networking > Virtual cloud networks > your VCN > Security lists > Default > Add ingress rules. Source `0.0.0.0/0`, protocol TCP, destination ports `80` and `443` (two rules, or `80,443`). The VM's own firewall is opened by the setup script in step 3.
5. **Idle reclamation.** Oracle can reclaim Always Free instances that sit idle (95th-percentile CPU under 20% over 7 days), and a demo server usually is idle. The common fix is to upgrade the account to **Pay As You Go**: Always Free resources stay free, and the reclamation rule is aimed at free-only accounts. Check Oracle's current wording. Either way, set a **budget alert of $1** right away (Billing > Budgets), so any charge emails you.

## 2. Get the free address

1. Go to **duckdns.org** and sign in (Google or GitHub).
2. Add a subdomain, for example `getpaid-demo`. That gives `getpaid-demo.duckdns.org`. Free accounts get up to 5.
3. Put the VM's public IP in its **current ip** box and press **update ip**.
4. Fallback with no sign-up at all: `https://<ip-with-dashes>.sslip.io` (for example `152-67-1-23.sslip.io`) also works with Caddy's automatic HTTPS. Use that as your `DOMAIN` below.

Check that it points at the VM: `ping getpaid-demo.duckdns.org` should show your IP.

## 3. Set up the server

```bash
ssh ubuntu@<ip>
git clone <your repo URL> getpaid && cd getpaid     # a private repo needs a GitHub deploy key or a token
bash deploy/server-setup.sh
```

The script installs Docker, Node 22 and git, opens ports 80 and 443 in the VM's firewall, and prints what it did. It is safe to run again. If it says it added you to the `docker` group, **log out and back in** before the next step.

## 4. Fill in the server's settings

```bash
cp .env.example .env
nano .env
```

Make **new random values for every secret. Never copy your laptop's file.** Generate each with `openssl rand -hex 32` unless noted.

| Setting                                                         | Value                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`                                                  | `docker-compose.yml:docker-compose.prod.yml` (add this line; it makes every plain `docker compose` command, `npm run n8n:go-live` and the scripts use the production files)           |
| `POSTGRES_PASSWORD`                                             | `openssl rand -hex 24` (letters and digits only, because it goes inside a URL)                                                                                                        |
| `DATABASE_URL`                                                  | `postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/payment_recovery`. This one is for migrations run from the server's shell. The web container gets its own value automatically |
| `ENCRYPTION_KEY`, `N8N_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`    | one new random value each                                                                                                                                                             |
| `LITELLM_MASTER_KEY`                                            | `sk-` followed by `openssl rand -hex 24`. Compose asks for it even though the gateway stays off                                                                                       |
| `DOMAIN`                                                        | `getpaid-demo.duckdns.org` (no `https://`)                                                                                                                                            |
| `APP_PUBLIC_URL`                                                | `https://getpaid-demo.duckdns.org`                                                                                                                                                    |
| `WEBHOOK_URL`                                                   | `https://getpaid-demo.duckdns.org/`                                                                                                                                                   |
| `DEMO_MODE`                                                     | `true`                                                                                                                                                                                |
| `DEMO_PASSWORD`                                                 | 16 or more characters. This is what you give people                                                                                                                                   |
| `DEMO_COOKIE_SECRET`                                            | `openssl rand -hex 32` (32 or more characters)                                                                                                                                        |
| `LOCAL_AI_URL`                                                  | `http://ollama:11434`                                                                                                                                                                 |
| `DEV_EMAIL_ALLOWLIST`                                           | the demo inbox only. Real emails can go to no other address                                                                                                                           |
| `AI_DEFAULT_PROVIDER`, `AI_DEFAULT_MODEL`, `AI_DEFAULT_API_KEY` | `gemini`, `gemini-3.5-flash-lite` and your Google AI Studio key. Every visitor uses this built-in model; the key never leaves the server                                              |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | your sandbox app (the webhook ID comes in step 8)                                                                                                                                     |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`                        | your Google OAuth client (step 8)                                                                                                                                                     |
| `TELEGRAM_BOT_USERNAME`                                         | the bot's username                                                                                                                                                                    |

The app will not start in production without a strong `DEMO_PASSWORD` and `DEMO_COOKIE_SECRET`. If the web container never becomes healthy, read its log (`docker compose logs web`): it names the setting that is wrong.

## 5. Start everything

```bash
docker compose up -d --build --wait
```

The first build takes several minutes on the Arm VM. The command returns when Postgres, n8n, the web app and Caddy are all healthy. Caddy asks Let's Encrypt for the HTTPS certificate by itself when it starts, which works only if the address already points at the VM and ports 80 and 443 are open.

## 6. Create the database

```bash
npm ci
npm run db:dev-auth && npm run db:migrate && npm run db:seed:showcase
```

This runs from the server's shell against the Postgres that listens on `127.0.0.1` only. `db:seed:showcase` loads the demo freelancer, the demo-script project ("Website redesign" for Hudson Street Bakery) and four more clients with projects in every state, so the dashboard looks lived-in: paid history in EUR, GBP and AUD, a first reminder and a Tier 3 final notice waiting in the Outbox, a client reply waiting in Replies, and a renewal on the calendar. Those extra invoices are history only: their PayPal links are made up. The live PayPal flow is the Website redesign project. Running it again changes nothing.

## 7. Set up n8n (privately)

n8n's editor is never on the internet. From your laptop, open a tunnel:

```bash
ssh -L 5678:127.0.0.1:5678 ubuntu@<ip>
```

Then open `http://localhost:5678` on your laptop. The first time, n8n asks you to create an owner account.

1. **Credentials > Create credential**, two of them, with exactly these names:
   - **Header Auth**, named `App internal API token`: name `Authorization`, value `Bearer <your INTERNAL_API_TOKEN>`.
   - **Telegram API**, named `Telegram bot`: the token from @BotFather.
2. On the server: `./scripts/import-workflows.sh` loads the eight workflows. (It refuses if n8n already has workflows, so it never makes duplicates.)
3. In the editor, open **each of the eight workflows**. Where a node shows a missing credential, pick `App internal API token` (or `Telegram bot` in "Approval handler"), then save.
4. Publish **PayPal webhook**, **Drafter**, **Sender**, **AI router** and **Calendar sync** from the editor.
5. On the server: `npm run n8n:go-live`. It brings "Approval handler" up to date, publishes it, "Scheduler" and "Reply listener", and restarts n8n. Publishing "Approval handler" registers `https://<domain>/webhook/...` with Telegram.

The workflows call `http://host.docker.internal:3000`. In production that name points at the web container, so they run unchanged.

## 8. Point the outside services at the new address

- **Telegram:** done by publishing "Approval handler" (step 7). Then press **Connect Telegram** in Settings > Integrations on the demo.
- **PayPal sandbox:** in your sandbox app, change the webhook URL to `https://<domain>/webhook/paypal` (same webhook, same ID; nothing else changes). That moves your laptop's webhook to the server. If the dashboard lets you add a second webhook, you can keep both and put the new one's ID in the server's `PAYPAL_WEBHOOK_ID`.
- **Google OAuth:** in your OAuth client, add the redirect URI `https://<domain>/api/integrations/gmail/callback` (keep the localhost one for development), then press **Connect Gmail** on the demo. **Use a separate demo Gmail account for the demo, not your personal one.**
- **AI:** in the demo's Settings > AI, choose a cloud model (Claude, or Groq for speed) and paste its key. The free VM is too small for good local models, and model downloads are turned off in demo mode.

## 9. Check it

- `docker compose ps`: every service is `healthy`.
- Open `https://<domain>/welcome`. The landing page loads without a password.
- Press **Open dashboard**. You land on the password page. Enter `DEMO_PASSWORD`. The dashboard opens with the banner "Demo: sandbox payments, emails only go to the demo inbox."
- `https://<domain>/rest/login` must **not** show n8n. It sends you to the password page (or shows a 404 page once you are signed in).
- `https://<domain>/api/clients` without signing in answers 401.
- Dates on the demo are real: the demo clock is a development tool and is ignored in production.

## 10. Looking after it

**Update** (after you push changes):

```bash
bash deploy/update.sh
```

It pulls, installs, builds, runs new migrations, restarts, and prints each service's health. It stops at the first problem.

**Back up** the database every day. Run it once by hand, then add the cron line:

```bash
bash deploy/backup.sh
crontab -e        # add:  0 3 * * * bash $HOME/getpaid/deploy/backup.sh >> $HOME/getpaid/deploy/backups/backup.log 2>&1
```

Backups go to `deploy/backups/<date>.sql.gz`, the 14 newest are kept, and git never sees them. They hold client data, so also copy them off the server now and then (for example with `scp`). To restore one:

```bash
gunzip -c deploy/backups/2026-11-09.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

(Restore into an empty database. To start clean, stop the app first, drop and recreate the database, then restore.)

**Logs:** `docker compose logs -f web n8n caddy`.

**Stop and start:** `docker compose stop` and `docker compose start`. Everything restarts by itself after a reboot.

## If something goes wrong

| What you see                                         | What to check                                                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The address doesn't open                             | DuckDNS points at the VM's IP (step 2). Ports 80 and 443 are open in **both** the security list and the VM firewall (steps 1 and 3)                                                                                              |
| Browser warns about the certificate                  | Caddy needs a minute after it starts. Check `docker compose logs caddy`. The domain must point at this VM, with ports 80 and 443 open, before Caddy can get a certificate. After fixing that, run `docker compose restart caddy` |
| The web container isn't healthy                      | `docker compose logs web`. It names a missing or weak setting (for example `DEMO_PASSWORD`)                                                                                                                                      |
| "Out of capacity" when creating the VM               | Try another availability domain, or try later                                                                                                                                                                                    |
| Telegram buttons do nothing                          | "Approval handler" must be published after `WEBHOOK_URL` is the https address. Publish it again                                                                                                                                  |
| PayPal events don't arrive                           | The sandbox webhook URL is `https://<domain>/webhook/paypal`, and `PAYPAL_WEBHOOK_ID` matches that webhook                                                                                                                       |
| `import-workflows.sh` says n8n already has workflows | That is the duplicate guard. Change workflows in the editor, or use `npm run n8n:go-live`                                                                                                                                        |
| `npm run n8n:go-live` can't find a credential        | It needs exactly one credential of each type (one Header Auth, one Telegram API). Create them first (step 7)                                                                                                                     |

## What stays private, and what to keep secret

- Only Caddy listens on the internet (ports 80 and 443). Postgres and the n8n editor listen on `127.0.0.1` only, so you reach them through SSH. Ollama and LiteLLM publish nothing.
- Caddy sends only `/webhook/*` to n8n. n8n's editor, test webhooks and API are not reachable.
- The server's `.env` lives only on the server. Nothing secret is in the images or in git.
- The demo password is shared and there is one demo user. It is a gate for a sandbox demo, not real sign-in: don't put real client data in it.
