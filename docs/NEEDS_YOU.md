# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **Live PayPal webhooks need a public HTTPS URL:** PayPal can't call `localhost`. To watch a sandbox payment arrive (demo step 2), expose n8n with a tunnel (for example `cloudflared tunnel --url http://localhost:5678`). Then set the sandbox app's webhook URL to `https://<tunnel>/webhook/paypal` with the invoicing, capture-refund and dispute events, put its id in `PAYPAL_WEBHOOK_ID`, and activate "PayPal webhook" in n8n (already imported, inactive). Needs your accounts and a tool installed on your PC.
- **Restart your dev server:** the `next dev` you have running (PID 948, port 3000) started before `msw` was installed, and its compile workers now crash on some routes ("Jest worker encountered 2 child process exceptions"). A restart (`npm run dev`) fixes it. The new Invoices card on the project page hasn't been viewed in a browser yet because of this.

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.
- **Playwright browser (for the M10 E2E test):** run `npx playwright install chromium` once on your PC. Until then I check screens with the Microsoft Edge that ships with Windows.

## Done

- **PayPal partial payments blocked for the sandbox account's country** (3 Nov 2026). Resolved by your approved change (`docs/CHANGE-installments-and-templates.md`): installments (separate invoices) replace PayPal partial payments everywhere, so no other sandbox account is needed.
