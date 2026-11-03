# Needs you

Things only you can do (values in your local env file, accounts or keys, installing apps, scope changes). Work that doesn't depend on them continues meanwhile.

## Open

- **Real sign-in (before any deployment):** the dashboard acts as the seeded demo user in development and refuses to run in production (`apps/web/src/lib/auth.ts`). Before deploying, decide on sign-in (Supabase Auth with email magic links is the natural fit) and create the Supabase project and keys. This isn't in `docs/FEATURES.md`, so it's a scope decision for you. Nothing in M2–M9 is blocked.
- **Playwright browser (for the M10 E2E test):** run `npx playwright install chromium` once on your PC. Until then I check screens with the Microsoft Edge that ships with Windows.

## Done
