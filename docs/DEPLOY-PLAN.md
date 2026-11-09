# Deployment plan: optional components on demand, and the public demo on Oracle Cloud

**For the coding model.** Build this before Phase 2 (the owner needs a public demo URL for the hackathon). Four steps, D1 to D4, one branch and one commit each (see `docs/PARALLEL-WORKFLOW.md`). Follow `CLAUDE.md` and the testing policy in `docs/PHASE2-PLAN.md` section 0.4 (security and connectivity tests only). Never read or print `.env`; new settings go in `.env.example` with a comment.

The owner's own steps (Oracle account, DuckDNS, server commands) are in `docs/DEPLOY.md`, which you write in D4 from section 6 of this file.

---

## 1. Goals

1. **Nothing heavy is downloaded unless the user wants it.** A user with a cloud AI key never downloads Ollama or LiteLLM. Local AI is switched on with one command, and its models download when the user presses a button in the app. (Speech-to-text was dropped from the product on 9 Nov 2026; there is no Whisper service.)
2. **A public demo at a free HTTPS address** (`https://<name>.duckdns.org`) on an Oracle Cloud Always Free Arm VM, with **no tunnel**. Telegram, PayPal and Cal.com webhooks reach it directly.
3. **The public demo is gated.** The dashboard can't be used by strangers: a demo password protects everything except the landing page, the webhooks and (from Phase 2 step C3) the client signing page. n8n's editor, Postgres and the AI services are never reachable from the internet.

---

## 2. Decisions (log in `docs/DECISIONS.md` in D1)

| # | Decision | Why |
| --- | --- | --- |
| E1 | Ollama and LiteLLM are behind Docker Compose profiles (`local-ai`, `gateway`). `docker compose up` starts only Postgres and n8n (plus web and Caddy in production). | Profiled services aren't pulled or started unless asked. A cloud-key user downloads none of them. |
| E2 | The app never controls Docker (no Docker socket in any container). Switching a component on is a command (`npm run local-ai:on`); the app shows that command and then detects the service. | Mounting the Docker socket gives a container full control of the host; not worth it. |
| E3 | Model downloads are buttons in the app, through Ollama's own API (`POST /api/pull`), with progress. Disabled in demo mode. | "Download when they click", without giving the app any power beyond those two APIs. |
| E4 | Production runs the web app in a container (Next.js standalone build) behind Caddy, which gets a Let's Encrypt certificate for the DuckDNS name automatically. Only Caddy publishes ports (80, 443). | Caddy's automatic HTTPS needs no extra setup; DuckDNS is a free subdomain. |
| E5 | Caddy sends `/webhook/*` to n8n and everything else to the web app. n8n's editor stays private (the owner reaches it with an SSH port-forward). | Fixes the tunnel problem permanently while keeping n8n's editor off the internet. |
| E6 | In production, the web container gets the network alias `host.docker.internal`, so the n8n workflows, which call `http://host.docker.internal:3000`, work unchanged. | No workflow edits, same files for dev and prod. |
| E7 | A **demo gate** (`DEMO_MODE=true` plus `DEMO_PASSWORD`) lets the seeded demo user run in production, behind a password page. Without both, production still refuses to start, as today. | Real sign-in isn't built; this is the minimum safe way to show a public demo. |
| E8 | The demo uses cloud models (a Claude, Groq or OpenAI key set in Settings). Local models stay available for self-hosters. | The free Arm VM now has 2 CPUs; local models would make the demo slow. |
| E9 | In demo mode, AI base URLs may only point to the known provider hosts and the local service names (`ollama`, `litellm`), never to other internal hosts. | Stops a visitor from using the "Custom URL" field to make the server call `postgres:5432` or `n8n:5678` (server-side request forgery). |

---

## 3. D1: Optional components on demand

**Compose (`docker-compose.yml`):**

- `ollama`: profile `local-ai` (rename from `ollama`; keep the old name working as a second profile if that's easy).
- `litellm`: profile `gateway`. Remove it from the default start. Update `docs/setup.md` and the health table.
- Postgres and n8n stay in the default set.

**Scripts (root `package.json`):**

```
"local-ai:on":  "docker compose --profile local-ai up -d --wait ollama",
"local-ai:off": "docker compose --profile local-ai stop ollama",
"gateway:on":   "docker compose --profile gateway up -d --wait litellm"
```

**In the app (Settings > AI), for the Ollama preset:**

1. On opening, the server checks `GET <ollama base>/api/tags` (2 s timeout). Base URL from a new env `LOCAL_AI_URL` (default `http://127.0.0.1:11434`; in production `http://ollama:11434`). The preset's base URL becomes `${LOCAL_AI_URL}/v1`.
2. Not reachable: show "Local AI is off. To use it, run `npm run local-ai:on` (downloads about 1.5 GB once). Or pick a cloud model instead; you don't need local AI."
3. Reachable, model missing: a short list of suggested models (`llama3.2` about 2 GB, `qwen2.5:3b` about 1.9 GB) plus a model name field, and a **Download** button. `POST /api/settings/ai/local-models/pull { model }` (model name checked against `^[a-z0-9][a-z0-9._:/-]{0,80}$`) calls Ollama `POST /api/pull` with `stream: true` and relays progress to the browser (server-sent events, or a job ID the page polls every 2 s). One pull at a time per server.
4. Downloaded models appear in the model picker.

**Demo mode:** the Download buttons are hidden and the pull route answers 403.

**Tests:** connectivity: the Ollama status check reports "off" when the mock server is down and lists models when up (msw); security: the pull route refuses an invalid model name, refuses without the signed-in user, and answers 403 in demo mode.

---

## 4. D2: Production containers

**`apps/web/Dockerfile`** (multi-stage):

- Build stage: `node:22-bookworm-slim`, `npm ci` at the repo root (workspaces), `npm run build --workspace web` with `output: "standalone"` set in `next.config` (add it).
- Run stage: the official Playwright image for the pinned `playwright-core` version (`mcr.microsoft.com/playwright:v<version>-noble`; it's multi-arch, so it runs on Oracle's Arm VM), which already has Chromium and its libraries for the invoice PDFs. Copy `.next/standalone`, `.next/static` and `public`. Run as the image's non-root user. `NODE_ENV=production`, port 3000, `CMD ["node", "apps/web/server.js"]` (check the standalone output's path).
- Check how the app finds Chromium today (`playwright-core` plus a browser path or channel) and make it work in the image, through an env such as `CHROMIUM_PATH` if needed.

**`docker-compose.prod.yml`** (used with `docker compose -f docker-compose.yml -f docker-compose.prod.yml`):

- `web`: builds `apps/web/Dockerfile`, `env_file: .env`, volumes for the invoice archive (`INVOICE_ARCHIVE_DIR=/data/invoices`), meeting uploads and `.data`, `restart: unless-stopped`, on the internal network with the alias `host.docker.internal` (E6). No published port.
- `caddy`: `caddy:2` (pin a version), ports `80:80` and `443:443`, volumes `./deploy/Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy_data`, `caddy_config`, env `DOMAIN`.
- `n8n`: in production, published only on `127.0.0.1:5678` (for the owner's SSH port-forward), with `WEBHOOK_URL=https://${DOMAIN}/`, `N8N_PROTOCOL=https`, `N8N_HOST=${DOMAIN}`, and `N8N_SECURE_COOKIE=true`.
- `postgres`: published only on `127.0.0.1:5432` (for migrations from the server's shell). Strong `POSTGRES_PASSWORD`.
- `ollama`, `litellm`: unchanged profiles; no published ports in production (the web app reaches them by service name).
- `restart: unless-stopped` on everything.

**`deploy/Caddyfile`:**

```
{$DOMAIN} {
	encode zstd gzip

	@webhooks path /webhook/*
	handle @webhooks {
		reverse_proxy n8n:5678
	}

	handle {
		reverse_proxy web:3000
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
}
```

Nothing else reaches n8n: no `/webhook-test/*`, no `/rest/*`, no editor.

**Server URLs in env (`.env.example`):** `DOMAIN`, `APP_PUBLIC_URL=https://${DOMAIN}`, `WEBHOOK_URL=https://${DOMAIN}/`, `LOCAL_AI_URL`, `DEMO_MODE`, `DEMO_PASSWORD`, `DEMO_COOKIE_SECRET`.

**Done when:** `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` with `DOMAIN=localhost` serves the app through Caddy on `https://localhost` (Caddy's local certificate), `/webhook/paypal` reaches n8n, and `/rest/login` (n8n) answers 404 through Caddy. **Tests:** none (manual check; record it in the commit).

---

## 5. D3: The demo gate (security, required before the URL goes public)

**Where:** `apps/web/src/lib/demo-gate.ts` (pure helpers) and `apps/web/src/middleware.ts` (or `proxy.ts`, whichever this Next.js version uses; check the docs for Next 16).

- **Active only when** `NODE_ENV=production` and `DEMO_MODE=true`. Then `lib/auth.ts` allows the seeded demo user in production, but only if `DEMO_PASSWORD` is at least 16 characters and `DEMO_COOKIE_SECRET` at least 32. Otherwise production still refuses to start, with a clear message.
- **Open paths (no password):** `/welcome`, `/demo-login`, `/api/demo-login`, `/api/webhooks/*`, `/sign/*` and `/api/sign/*` (the client signing page, Phase 2 C3; it has its own token check), `/api/internal/*` (still protected by the internal token), `/api/integrations/gmail/callback` (it's protected by the OAuth state check), `/_next/*`, `/favicon*`, `/getpaid-stamp.svg`, `/fonts/*`. Everything else needs the cookie.
- **Login:** `/demo-login` is a one-field form. `POST /api/demo-login { password, next }` compares with `DEMO_PASSWORD` using `timingSafeEqual` on SHA-256 hashes (like `internal-auth.ts`). On success, set the cookie `gp_demo` = `<expiry>.<HMAC-SHA256(expiry, DEMO_COOKIE_SECRET)>`, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`. Redirect to `next` only if it's a same-site path (starts with `/`, not `//`, no scheme); otherwise `/`.
- **Rate limit:** 5 failed tries per IP per 10 minutes (in memory; the IP from `x-forwarded-for` set by Caddy, first value), then 429 for 10 minutes.
- **Missing or bad cookie:** pages redirect to `/demo-login?next=<path>`; API routes answer 401 JSON.
- **Demo-mode limits:** model pulls off (D1); E9's base URL allowlist on save and before every call (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`, and the hosts `ollama`, `litellm`); the dev email allowlist still applies to every send; PayPal stays sandbox-only.
- A small banner on every app page: "Demo: sandbox payments, emails only go to the demo inbox."

**Tests (security):** an API route without the cookie answers 401; a tampered or expired cookie is refused; `/api/webhooks/paypal` and `/welcome` work without it; the 6th wrong password in 10 minutes gets 429; `next=//evil.com` and `next=https://evil.com` redirect to `/`; with `DEMO_MODE` unset, production refuses to start; in demo mode, saving a custom AI URL of `http://postgres:5432/v1` or `http://n8n:5678/v1` is refused.

---

## 6. D4: Runbook (`docs/DEPLOY.md`) and helper scripts

Write `docs/DEPLOY.md` for the owner from this section, and add:

- `deploy/server-setup.sh`: installs Docker (official convenience script), Node 22, git; opens ports 80 and 443 in the VM's firewall (see 6.3); idempotent; prints what it did.
- `deploy/update.sh`: `git pull`, build, `npm ci`, `npm run db:migrate` (against the 127.0.0.1 Postgres), `docker compose ... up -d`, then prints the health of each service.
- `deploy/backup.sh`: `pg_dump` to `deploy/backups/<date>.sql.gz`, keeping 14; a cron line in the runbook to run it daily. Backups are gitignored.

### 6.1 The free address (DuckDNS)

1. Go to **duckdns.org** and sign in (Google or GitHub).
2. Add a subdomain, for example `getpaid-demo`, giving `getpaid-demo.duckdns.org`. Free accounts get up to 5.
3. Set its IP to the VM's public IP (6.2) and press **update ip**.
4. Fallback, with no sign-up at all: `https://<ip-with-dashes>.sslip.io` (for example `152-67-1-23.sslip.io`) also works with Caddy's automatic HTTPS.

### 6.2 The Oracle VM

1. Sign up at **oracle.com/cloud/free**. A card is needed to verify identity. Pick a **home region** near you (Mumbai or Hyderabad); you can't change it later, and Always Free resources only exist there.
2. **Compute > Instances > Create instance:**
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build).
   - Shape: **VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory**. Oracle reduced the Always Free Arm allowance to 2 OCPUs and 12 GB in mid-2026, and some guides still say 4 and 24; staying at 2 and 12 keeps it free.
   - Boot volume: 100 GB (the free allowance is 200 GB in total).
   - Add your SSH public key.
   - If it says "Out of capacity", try another availability domain, or try again later. It's common.
3. **Networking:** reserve the public IP (Networking > Reserved public IPs) and attach it, so the address never changes.
4. **Open ports 80 and 443** in two places:
   - The VCN's security list (Networking > Virtual cloud networks > your VCN > Security lists > Default > Add ingress rules: source `0.0.0.0/0`, TCP, destination ports 80 and 443).
   - The VM's own firewall (Oracle's Ubuntu images block them): `deploy/server-setup.sh` runs
     ```
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
5. **Idle reclamation:** Oracle can reclaim Always Free instances that sit idle (95th-percentile CPU under 20% over 7 days), and a demo server usually is idle. The common fix is to upgrade the account to **Pay As You Go**: Always Free resources stay free, and the reclamation rule is aimed at free-only accounts (check Oracle's current wording). Set a **budget alert of $1** right away, so any charge emails you.

### 6.3 On the server (the owner runs these)

```
ssh ubuntu@<ip>
git clone <your repo URL> getpaid && cd getpaid      # private repo: use a GitHub deploy key or a token
bash deploy/server-setup.sh
cp .env.example .env && nano .env                     # fill it in (see below)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --wait
npm ci
npm run db:dev-auth && npm run db:migrate && npm run db:seed
./scripts/import-workflows.sh
```

In `.env` on the server: new random values for every secret (never copy your laptop's `.env`), plus `DOMAIN=getpaid-demo.duckdns.org`, `APP_PUBLIC_URL`, `WEBHOOK_URL=https://getpaid-demo.duckdns.org/`, `DEMO_MODE=true`, `DEMO_PASSWORD` (16+ characters), `DEMO_COOKIE_SECRET` (`openssl rand -hex 32`), `LOCAL_AI_URL=http://ollama:11434`, `DATABASE_URL` pointing at `127.0.0.1:5432` (for migrations run from the shell; the web container's own value uses the `postgres` host, so set both as the compose file expects), and `DEV_EMAIL_ALLOWLIST` set to the demo inbox.

**n8n, privately:** from your laptop, `ssh -L 5678:127.0.0.1:5678 ubuntu@<ip>`, then open `http://localhost:5678`. Create the two credentials (Header Auth `Bearer <INTERNAL_API_TOKEN>`, Telegram bot), then on the server run `npm run n8n:go-live`.

### 6.4 Point the outside services at the new address

- **Telegram:** republish "Approval handler" in n8n; it registers `https://<domain>/webhook/...` with Telegram.
- **PayPal sandbox:** edit the webhook URL to `https://<domain>/webhook/paypal` (same ID; nothing else changes).
- **Google OAuth:** in your OAuth client, add the redirect URI `https://<domain>/api/integrations/gmail/callback` (keep the localhost one for development), then press Connect Gmail on the demo. Use a separate demo Gmail account for the demo, not your personal one.
- **AI:** in the demo's Settings > AI, set a cloud model (Claude, or Groq for speed) with its key (E8).

### 6.5 Updating and checking

- Update: `bash deploy/update.sh`.
- Health: `docker compose ps`; open `https://<domain>/welcome`, log in through the demo gate, and check that `https://<domain>/rest/login` answers 404.
- Logs: `docker compose logs -f web n8n caddy`.

---

## 7. Don'ts

- Don't mount the Docker socket into any container, and don't let the app start or stop containers.
- Don't publish Postgres, n8n, Ollama or LiteLLM on a public interface; only Caddy listens publicly.
- Don't route anything but `/webhook/*` to n8n.
- Don't let production run without the demo gate (or, later, real sign-in).
- Don't put secrets in the images, the Caddyfile or git. The server's `.env` is created on the server.
- Don't download models on the demo server from the app (demo mode turns that off).
