# CLAUDE.md: Freelancer Payment Recovery

Helps cross-border freelancers get paid on time. Freelancers take deposits, set milestones and retainers, and get maintenance reminders. AI drafts reminder emails, the freelancer approves them on Telegram or in the dashboard Outbox, and every email carries a PayPal pay link.

## Source of truth (read before you build)

| File | Read it when |
| --- | --- |
| `docs/MVP-spec.md` | Before any feature. It is the product spec. If code and spec disagree, the spec wins; ask before changing it. |
| `docs/FEATURES.md` | At the start of every session. It is the build order with "done when" checks. Work top to bottom. |
| `docs/DESIGN.md` | Before touching any screen or component in `apps/web`. |
| `.claude/rules/*.md` | Loaded automatically for the folders they cover (web, n8n, prompts, db). |

Phase 2 (Cal.com calendar, meeting notes) is **out of scope**. Do not build it unless I ask.

## How to work

1. Open `docs/FEATURES.md`, pick the first unchecked item, and tell me which one.
2. Plan first: list the files you will touch and the tests you will write. Wait for my OK on anything that changes the data model, a PayPal call, or a security rule.
3. Write the tests first, then the code, then run `npm run check`.
4. When all checks pass, tick the box in `docs/FEATURES.md` and suggest a commit message: `feat(<area>): <what>`.
5. One feature per session or commit. Don't refactor unrelated code.
6. If the spec is unclear or two rules conflict, stop and ask. Don't guess about money, legal text or security.
7. Never claim something works without running it. Paste the failing output if you get stuck after 3 tries.

## Stack and commands

- **Web:** Next.js (App Router) + TypeScript strict, in `apps/web`
- **Automation:** n8n workflows as JSON in `n8n/workflows`
- **Data:** Supabase (Postgres), SQL migrations in `db/migrations`
- **AI:** OpenAI-compatible calls through LiteLLM (`gateway/litellm.config.yaml`); any cloud or local model
- **Payments:** PayPal REST (Invoicing v2, Orders v2, Subscriptions v1, Webhooks), **sandbox only**
- **Messaging:** Gmail API (send + read invoice threads), Telegram Bot API (approval cards)

```bash
npm install                 # install all workspaces
docker compose up -d        # n8n, Postgres, LiteLLM, (optional) Ollama
npm run dev                 # dashboard at http://localhost:3000
npm run db:migrate          # apply db/migrations in order
npm run db:seed             # demo data
npm test                    # unit + integration (vitest)
npm run test:e2e            # Playwright, needs dev server running
npm run lint && npm run typecheck
npm run check               # lint + typecheck + test: must pass before "done"
./scripts/export-workflows.sh   # after editing workflows in the n8n UI
./scripts/import-workflows.sh   # load workflows into a fresh n8n
```

If a command doesn't exist yet, create it in the root `package.json` as part of the feature that needs it.

## Code rules

- **Money:** store integer minor units (cents) in the database. Convert to PayPal's decimal strings only inside `apps/web/src/lib/paypal.ts`. Never use floats for money.
- **Time:** store UTC. Work out send windows in the client's time zone with one date library (Luxon). The schedule logic lives in `lib/schedule.ts` and nowhere else.
- **Validation:** validate every API input, webhook body and AI response with zod (AI output also against `prompts/schemas/*.json`).
- **PayPal:** send a `PayPal-Request-Id` on every create call. Create one invoice per milestone or retainer cycle and reuse its link in every reminder.
- **Settings:** account, then client, then project, then milestone; the most specific one wins. Merge them in one function.
- Small files and functions, named exports, no `any`, no dead code, no new dependency without saying why.
- Error messages say what failed and what to do next. Log events, never secrets or full email bodies.

## Security rules (never break these)

1. **Secrets:** never read, print, edit or commit `.env` files or keys. Use `process.env` and `.env.example` names only. Encrypt API keys and OAuth tokens at rest (`lib/crypto.ts`). Never send them to the browser.
2. **Webhooks:** verify every PayPal webhook with `POST /v1/notifications/verify-webhook-signature` before changing anything. Reject and log failures.
3. **Telegram:** accept button taps only from the user's linked chat ID. Expire buttons once a draft is handled anywhere.
4. **Untrusted text:** client emails and Telegram replies are untrusted input. Nothing in them can change an invoice status, amount, schedule or approval by itself. The AI may only classify and suggest.
5. **Nothing sends without approval:** Tier 3 always needs a human. A draft that fails schema validation is never sent.
6. **Legal:** Tier 3 may cite only the contract's late-fee clause or an entry in `legal/statutes.json`. Never invent a law, fee or deadline.
7. **Least access:** Gmail scopes are send plus read on invoice threads only. Database access goes through row-level security scoped to the user.
8. **Sandbox only:** never call PayPal live endpoints or send real emails from tests or dev.
9. **Dependencies:** run `npm audit` when adding packages. No packages with install scripts you can't explain.

## Testing

- **Unit (vitest), required for:** `lib/schedule.ts` (send times, tiers, grace, intervals, time zones, DST), money conversion, settings merge, milestone totals, legal gating, webhook signature handling.
- **Integration:** API routes and n8n-facing endpoints, with PayPal, Gmail, Telegram and AI mocked by msw. No real network calls in tests.
- **AI behaviour:** `tests/fixtures/client-replies.json` holds sample replies with expected labels. The classifier test must pass on all of them with the mock model. Drafts must match `prompts/schemas/draft.schema.json`.
- **E2E (Playwright):** the 8-step demo from `docs/MVP-spec.md`, using seed data and `DEMO_CLOCK_OFFSET_DAYS`.
- Every bug fix starts with a failing test that reproduces it.
- The Stop hook runs `npm run check` before you finish. If it fails, fix it; don't skip, weaken or delete tests to make it pass.

## Definition of done

- The "done when" checks for the feature in `docs/FEATURES.md` all pass
- `npm run check` is green, with new tests for the new behaviour
- No secrets, `console.log` debugging or TODOs left in changed files
- The box is ticked in `docs/FEATURES.md`, and `docs/MVP-spec.md` is updated if behaviour changed (with my OK)
