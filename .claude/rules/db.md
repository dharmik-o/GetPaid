---
paths:
  - "db/**"
---
# Database rules

- Never edit a migration that has been applied. Add a new numbered file instead.
- Money columns are integer cents with a currency column; timestamps are `timestamptz` in UTC.
- Every table with user data has row-level security limited to its owner.
- Secrets columns (tokens, API keys) hold ciphertext from `lib/crypto.ts` only.
- Seed data is fake: no real names, emails or PayPal accounts.
- Roles: the dashboard uses `authenticated` (RLS applies). `service_role` bypasses RLS and is only for n8n and webhook handlers, never user-facing dashboard code.
