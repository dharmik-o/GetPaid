# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **Live PayPal webhooks need a public HTTPS URL:** PayPal can't call `localhost`. To watch a sandbox payment arrive (demo step 2), expose n8n with a tunnel (for example `cloudflared tunnel --url http://localhost:5678`). Then set the sandbox app's webhook URL to `https://<tunnel>/webhook/paypal` with the invoicing, capture-refund and dispute events, put its id in `PAYPAL_WEBHOOK_ID`, and activate "PayPal webhook" in n8n (already imported, inactive). Needs your accounts and a tool installed on your PC.
- **Restart your dev server:** the `next dev` you have running (PID 948, port 3000) started before `msw` was installed, and its compile workers now crash on some routes ("Jest worker encountered 2 child process exceptions"). A restart (`npm run dev`) fixes it. The new Invoices card on the project page hasn't been viewed in a browser yet because of this.

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.
- **Playwright browser (for the M10 E2E test):** run `npx playwright install chromium` once on your PC. Until then I check screens with the Microsoft Edge that ships with Windows.

- **AI router token for n8n (needed from M5, when the drafter calls the router):** set `INTERNAL_API_TOKEN` in your local env file (`openssl rand -hex 32`), restart the dev server, then in n8n (http://localhost:5678) create a **Header Auth** credential named `App internal API token` with name `Authorization` and value `Bearer <the same token>`, and pick it in the "Route in the app" node of "AI router" (already imported, inactive). Until then the endpoint answers 503 and nothing else is affected.
- **Check the AI with a real model by hand (M4 "Test connection" sign-off):** the done-when needs Claude and Ollama by hand, which need your key and your PC:
  1. **Claude:** in Settings > AI, pick Claude, paste your Anthropic API key, keep model `claude-sonnet-5-5` (or another id you have), save, and press **Test connection**. All 4 tasks should pass.
  2. **Ollama:** start it (`ollama serve`, or `docker compose --profile ollama up -d ollama`), pull a small model (`ollama pull llama3.2`, about 2 GB), pick Ollama (local) with model `llama3.2`, save, and test again.
- **The protect-files hook blocked one of my commands (M4):** to run the AI router by hand against the local LiteLLM gateway, I ran a one-off script with Node's `--env-file-if-exists` option pointing at your local env file, so it could use `LITELLM_MASTER_KEY` without printing it. The hook refused because the command named the env file. I stopped there and didn't route around it. I ran the same check with no key instead: LiteLLM answered 401, and the router correctly fell back to the template. If you want that check with the key, enter the gateway in Settings > AI (Custom URL `http://127.0.0.1:4000/v1`, local, your master key, model `mock`) and press Test connection. Expect "template" for every task, because the mock model always answers `{"ok": true}`, which fails the schemas.

## Done

- **PayPal partial payments blocked for the sandbox account's country** (3 Nov 2026). Resolved by your approved change (`docs/CHANGE-installments-and-templates.md`): installments (separate invoices) replace PayPal partial payments everywhere, so no other sandbox account is needed.
