# Freelancer Payment Recovery

Gets cross-border freelancers paid on time: deposits, milestones, retainers, AI-drafted reminders approved on Telegram or in the Outbox, and PayPal pay links.

Folders:
- apps/web      Next.js dashboard (what freelancers see)
- n8n           automation workflows (scheduler, drafter, approvals, sender, reply listener, PayPal webhooks, AI router)
- prompts       AI prompts + JSON schemas the AI must follow
- legal         verified late-payment laws by country (Tier 3 may cite only these)
- db            database tables (Supabase / Postgres) + demo data
- gateway       LiteLLM config so any cloud or local AI works
- scripts       export/import n8n workflows, demo clock
- tests         unit tests + sample client replies
- docs          spec, setup guide, demo script

## Building with Claude Code

- `CLAUDE.md`: rules Claude Code follows every session (workflow, code, security, testing, definition of done)
- `docs/MVP-spec.md`: the product spec · `docs/FEATURES.md`: build order with "done when" checks · `docs/DESIGN.md`: screens and visual rules
- `.claude/settings.json`: permissions (no reading `.env`, no `git push`) and hooks
- `.claude/hooks/`: block edits to secrets, auto-format edited files, run `npm run check` before Claude finishes
- `.claude/rules/`: extra rules that load only for `apps/web`, `n8n`, `prompts`/`legal`, and `db`

Create `.env` yourself from `.env.example`. Claude Code is blocked from reading or writing it.
