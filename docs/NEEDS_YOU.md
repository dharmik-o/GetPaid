# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **PayPal partial payments are blocked for your sandbox account (blocks M3 "Invoices" sign-off and demo steps 2 and 6).** PayPal refuses every invoice with partial payments on: *"Partial payments are not available in your country."* The spec turns them on for every invoice (deposits with a minimum due, "pay in parts", the $750-of-$1,500 demo step). The code follows the spec, and everything else works in the sandbox (create, no-duplicate retry, send, cancel, delete). Your call:
  1. **(Recommended for the demo)** In developer.paypal.com > Sandbox > Accounts, create a **Business** sandbox account in a country where PayPal Invoicing offers partial payments (the United States is the safe choice). Create a new sandbox REST app linked to it, then put that app's client id and secret in `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. The webhook id belongs to the app, so add the webhook to the new app and update `PAYPAL_WEBHOOK_ID` too. Then run `npm run test:paypal:sandbox`; all 8 tests should pass.
  2. **Scope question for launch:** if partial payments aren't offered to business accounts in the launch markets (India, the Philippines, Latin America, Sri Lanka), deposits-with-minimum and "pay in parts" can't work there as specced. An alternative would be separate invoices per installment. That changes the spec, so it's your decision; I haven't built it.
- **Live PayPal webhooks need a public HTTPS URL:** PayPal can't call `localhost`. To watch a sandbox payment arrive (demo step 2), expose n8n with a tunnel (for example `cloudflared tunnel --url http://localhost:5678`). Then set the sandbox app's webhook URL to `https://<tunnel>/webhook/paypal` with the invoicing, capture-refund and dispute events, put its id in `PAYPAL_WEBHOOK_ID`, and activate "PayPal webhook" in n8n (already imported, inactive). Needs your accounts and a tool installed on your PC.
- **Restart your dev server:** the `next dev` you have running (PID 948, port 3000) started before `msw` was installed, and its compile workers now crash on some routes ("Jest worker encountered 2 child process exceptions"). A restart (`npm run dev`) fixes it. The new Invoices card on the project page hasn't been viewed in a browser yet because of this.

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.
- **Playwright browser (for the M10 E2E test):** run `npx playwright install chromium` once on your PC. Until then I check screens with the Microsoft Edge that ships with Windows.

## Done
