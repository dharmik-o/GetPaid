---
paths:
  - "apps/web/**"
---
# Dashboard rules

- Follow `docs/DESIGN.md` for layout, components, tokens and copy.
- Server-only code (PayPal, crypto, service keys) lives in `src/lib` and route handlers. Never import it into client components.
- Every route handler validates input with zod and checks that the record belongs to the signed-in user.
- Use one money formatter and one date formatter from `src/lib`; show both time zones on send times.
- Each new screen needs an empty state, a loading state and an error state.
