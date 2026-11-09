# GetPaid

GetPaid helps cross-border freelancers get paid on time. It protects payment before the work starts, with deposits, milestones and payment holds. After a deadline passes, it recovers the money with AI-drafted reminders that the freelancer approves on Telegram or in the dashboard. Every reminder carries a PayPal pay link.

**PayPal runs in sandbox mode only, and this is a local demo.** There's no hosted version and no sign-in yet: the dashboard acts as one seeded demo freelancer, and it refuses to run in production.

## What it does

- **Billing:** deposits, milestones, installments (separate PayPal invoices with their own due dates), milestone holds, monthly retainers with auto-pay, and maintenance and renewal reminders.
- **Reminders on the freelancer's rules:** payment terms, intervals, tiers and send windows, set per account, client, project or milestone, and worked out in the client's time zone.
- **AI drafts, and a person approves:** approval is required by default. A freelancer can choose to auto-send Tier 1, but Tier 3, the final notice, always needs a human.
- **Replies are read:** a client who writes back puts that invoice's reminders on hold. The AI suggests a next step, such as splitting the balance into installments. It can't change an invoice, an amount or a schedule by itself.
- **Any model:** Claude, OpenAI, Gemini, Groq, OpenRouter, or a local model through Ollama or LM Studio, all through one OpenAI-compatible call. If a model fails, a fixed template takes over.
- **Payment status comes from PayPal:** only signature-verified webhooks mark money as paid, and that stops the reminders.
- **Invoice PDFs:** six built-in themes or your own HTML, an optional signature, and a local archive of every PDF sent.
- **A record of what happened:** a timeline per client, and metrics for the amount recovered, days late and recovery rate.

A landing page is at `/welcome`, and the dashboard is at `/`.

## Tech stack

| Layer      | What's used                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Web        | Next.js 16 (App Router), React 19, TypeScript strict, Motion, GSAP on the landing page only                 |
| Automation | n8n, with seven workflows as JSON in `n8n/workflows`                                                        |
| Data       | Postgres 17 with row-level security, in SQL migrations (`db/migrations`); built to move to Supabase         |
| Payments   | PayPal REST, sandbox: Invoicing v2, Orders v2, Payments v2, Subscriptions v1, Catalog Products v1, Webhooks |
| AI         | Any OpenAI-compatible model; prompts in `prompts`, JSON schemas in `prompts/schemas`, LiteLLM as a gateway  |
| Messaging  | Gmail API (`gmail.send`, `gmail.readonly`), Telegram Bot API                                                |
| Documents  | Mustache templates, a sanitiser, and headless Chromium with JavaScript and network off                      |
| Tests      | vitest, msw, PGlite (real migrations and RLS in memory), Playwright                                         |

## See it working in five minutes

This runs the 8 demo steps in a real browser against a real Postgres, with PayPal, Gmail, Telegram and the model faked. You need only Node and Docker, and no accounts or env file.

```bash
git clone https://github.com/dharmik-o/GetPaid.git
cd GetPaid
npm install
npx playwright install chromium
npx playwright test demo
```

`npm run test:e2e` runs every browser test, and `npm run check` runs lint, types and the unit and integration tests, with no network calls.

## Full local setup

These steps are the same on Windows and macOS unless a step says otherwise. On Windows, use PowerShell.

### 1. Install what you need

- [Node.js](https://nodejs.org) 22.9 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop), running
- Git
- A free [PayPal developer account](https://developer.paypal.com)

```bash
git clone https://github.com/dharmik-o/GetPaid.git
cd GetPaid
npm install
npx playwright install chromium
```

Chromium is what makes the invoice PDFs.

### 2. Create your env file

| Windows (PowerShell)          | macOS                  |
| ----------------------------- | ---------------------- |
| `Copy-Item .env.example .env` | `cp .env.example .env` |

Run this four times, once for each secret below. It works on both systems:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then fill these in, and never commit the file:

| Variable             | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | Any local password. Use the same one inside `DATABASE_URL`                        |
| `ENCRYPTION_KEY`     | A generated value. Don't change it later, or stored keys and tokens can't be read |
| `N8N_ENCRYPTION_KEY` | A generated value                                                                 |
| `INTERNAL_API_TOKEN` | A generated value                                                                 |
| `LITELLM_MASTER_KEY` | `sk-` followed by a generated value                                               |

### 3. Add your PayPal sandbox keys

1. Go to [developer.paypal.com](https://developer.paypal.com), then **Apps & Credentials**, and make sure **Sandbox** is selected.
2. Create an app, and copy its keys into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. In the dashboard's sandbox accounts list, find or create a **US Personal** account to pay with. A buyer from some other countries, India for one, gets "seller doesn't accept payments in your currency".

The app only ever calls `api-m.sandbox.paypal.com`, so live keys won't work. You'll add `PAYPAL_WEBHOOK_ID` in step 7.

Run `npm run env:check` to check your file. It prints variable names only, never values.

### 4. Start the services

```bash
docker compose up -d --wait
```

This starts Postgres and n8n (http://localhost:5678), and returns once their health checks pass. Every port binds to `127.0.0.1`. Ollama and the LiteLLM gateway are optional and start only on request (`npm run local-ai:on`, `npm run gateway:on`).

### 5. Set up the database

Run these once, in this order:

```bash
npm run db:dev-auth
npm run db:migrate
npm run db:seed
```

- `db:dev-auth` adds what Supabase would provide to plain Postgres. It refuses any database that isn't local.
- `db:migrate` applies the migrations.
- `db:seed` adds a demo freelancer, the client Hudson Street Bakery, and its USD 3,000 project.

### 6. Start the dashboard

```bash
npm run dev
```

Open http://localhost:3000, or http://localhost:3000/welcome for the landing page. You can now create invoices against the PayPal sandbox and write reminders from the fixed templates. Automation and live payment updates need the next step.

### 7. Connect n8n and webhooks

PayPal and Telegram can only reach n8n through a public HTTPS address, so this needs a tunnel.

1. Start a tunnel to port 5678. `cloudflared tunnel --url http://localhost:5678` is the quickest, but it exposes the whole n8n editor while it runs. To let only `/webhook/*` through, use ngrok with this repo's policy: `ngrok http 5678 --url=https://<your-domain> --traffic-policy-file=gateway/ngrok-policy.yml`.
2. Set `WEBHOOK_URL` in your env file to the tunnel's address, then run `docker compose up -d n8n`.
3. In your PayPal sandbox app, add the webhook `https://<your-tunnel>/webhook/paypal`, and put its ID in `PAYPAL_WEBHOOK_ID`. Subscribe to `INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.SALE.COMPLETED` and the `BILLING.SUBSCRIPTION.*` events. Restart `npm run dev`.
4. Open http://localhost:5678 and create the n8n owner account. Add a **Header Auth** credential named `App internal API token`, with the name `Authorization` and the value `Bearer <your INTERNAL_API_TOKEN>`.
5. Import the workflows:

   ```bash
   docker compose exec n8n n8n import:workflow --separate --input=/home/node/workflows
   ```

   In Git Bash, put `MSYS_NO_PATHCONV=1` before that command, or Git Bash rewrites the path.

6. Open each workflow, choose your credential on any node that asks for one, and publish it.

To check that it's live, send an empty `POST` to `https://<your-tunnel>/webhook/paypal`. It should answer 400 with "Missing PayPal signature headers". A 404 means the workflow isn't published.

**Without n8n,** you can run the same jobs by hand, with `scheduler`, `sender` or `replies`. PayPal's webhooks do need n8n.

```bash
curl -X POST http://127.0.0.1:3000/api/internal/scheduler/run -H "Authorization: Bearer <INTERNAL_API_TOKEN>"
```

### 8. Optional: email and Telegram

- **Gmail** sends the reminders and reads replies on their threads. Create an OAuth client as `docs/setup.md` describes, and set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `DEV_EMAIL_ALLOWLIST`. The allowlist is the only set of addresses a dev send can reach. It's empty by default, which means nothing sends.
- **Telegram** carries the approval cards. Create a bot with @BotFather, set `TELEGRAM_BOT_USERNAME`, add its token to n8n as a Telegram credential named `Telegram bot`, and press **Connect Telegram** in Settings > Integrations. Without it, approve everything in the Outbox.

### 9. Optional: a local model with Ollama

```bash
npm run local-ai:on
```

This downloads the Ollama image (about 1.5 GB) once. Then in **Settings > AI**, press **Download llama3.2** under Local AI, pick **Ollama (local)**, choose the model, save, and press **Test connection**. To use Claude or another cloud model, pick its preset and enter your key. Keys are encrypted at rest and never sent back to the browser. With no model set, drafts come from the fixed templates.

## Put it online

To run the sandbox demo at a free HTTPS address on an Oracle Cloud server, behind a password page, follow [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Run the demo

The demo jumps forward in time with a dev-only clock, so an invoice can go overdue in seconds. It moves the app's clock, not PayPal's, and a banner on every page says it's moved. Production ignores it.

There are two ways to set it:

- **In the app:** **Settings > Demo clock**. Enter a number of days and press **Set the clock**. This lasts until the server restarts.
- **In your env file:** `DEMO_CLOCK_OFFSET_DAYS=21`, then restart `npm run dev`. Part of a day works, such as `21.25`. The Settings control wins until the next restart.

Enter `0` to go back to today.

| Step                | What you do                                                                                                     | Clock         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------- |
| 1. Set up           | Open Projects > Website redesign: USD 3,000 in three milestones                                                 | 0             |
| 2. Deposit          | Create the USD 900 deposit invoice and pay it as the sandbox buyer. Design turns Paid                           | 0             |
| 3. Overdue          | Mark Build delivered and invoice it, jump the clock, and run the Scheduler. A Tier 2 draft appears for approval | 21            |
| 4. Delivered        | Approve it. The email arrives with the PayPal link                                                              | 21            |
| 5. Client replies   | Reply "Can I pay half now and half on the 15th?", run the Reply listener, and approve the split                 | 22            |
| 6. Installment paid | Pay installment 1. Build shows Partially paid                                                                   | 22            |
| 7. Switch AI        | Change to a local model and redraft the next reminder                                                           | Past the 15th |
| 8. Close            | Home shows the amount recovered and days saved, and the client page shows the timeline                          | Past the 15th |

Emails go out only inside the client's send window, 9:00 to 17:00 New York time in the seed data. Start from a clean database, because the clock moves everything on the account. `docs/DEMO.md` is the full script, with exact clicks, what to say, and what to do when something is slow.

## What has run for real

Tests fake every outside service, so this is what has also been run live against the PayPal sandbox and real accounts:

| Ran live                                                                                                                                     | Only with fakes so far                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Invoices: create, send and cancel, deposits, installments, and a no-duplicate retry                                                          | A failed subscription charge, which PayPal's simulator can't sign |
| Holds: authorize, then capture and void, with a sandbox buyer                                                                                | A hold's reauthorize, which PayPal allows only after day 3        |
| Subscriptions: product, plan and subscription created, with a real webhook passing PayPal's signature check                                  | The whole 8-step demo as one live run                             |
| A real Gmail send, and a real reply read and labelled                                                                                        | A paid invoice arriving through its webhook                       |
| A real Telegram card and approval                                                                                                            |                                                                   |
| Test connection with `llama3.2` on Ollama: 4 of 4 tasks. Reply sorting with that model got 13 to 14 of 16 sample replies right over two runs |                                                                   |

## Safety rules

- **Webhooks:** each one is verified with PayPal's `verify-webhook-signature` before anything changes.
- **Client emails are untrusted:** nothing in a reply can change a status, amount, schedule or approval.
- **Legal text:** a final notice cites only the contract's own late-fee clause or an entry in `legal/statutes.json`. That table is empty until its wording has been reviewed, so today it's the clause or no citation at all.
- **Gmail:** the app reads only threads it stored when sending, and never lists or searches the mailbox.
- **Data:** every table with user data has row-level security, and keys and tokens are encrypted at rest.

## Repo layout

| Folder          | What's in it                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| `apps/web`      | The Next.js dashboard and landing page                                            |
| `n8n/workflows` | Scheduler, drafter, approvals, sender, reply listener, PayPal webhooks, AI router |
| `prompts`       | AI prompts and the JSON schemas every answer must match                           |
| `legal`         | The table of verified laws a final notice may cite                                |
| `db`            | SQL migrations and fake demo data                                                 |
| `gateway`       | LiteLLM config and the ngrok traffic policy                                       |
| `scripts`       | Database, checks and n8n helpers                                                  |
| `tests`         | Unit, integration, RLS and Playwright tests                                       |
| `docs`          | The spec, build order, design rules, decisions, setup guide and demo script       |

## Built with Claude Code

This was built with [Claude Code](https://claude.com/claude-code). `CLAUDE.md` holds the rules it follows, `docs/FEATURES.md` the build order with "done when" checks, and `docs/DECISIONS.md` the choices made along the way. `.claude/` holds its permissions and hooks, which block it from reading secrets and run the checks before it finishes.

## License

The project's own code is under the [MIT License](LICENSE). Third-party parts keep their own terms, and the MIT License doesn't cover them:

- **Clash Display** (the heading font) is under the ITF Free Font License from [Fontshare](https://www.fontshare.com/fonts/clash-display). If `apps/web/public/fonts` has no `ClashDisplay-*.woff2` files in your copy, download your own from Fontshare and put the Medium, Semibold and Bold files there. Without them, headings use a backup font, and the one Playwright check on that font fails.
- **GSAP** is under GreenSock's [standard no-charge license](https://gsap.com/standard-license), installed from npm.
- Other npm packages, including the IBM Plex, Instrument Sans and Mrs Saint Delafield fonts, are under their own open-source licenses.
