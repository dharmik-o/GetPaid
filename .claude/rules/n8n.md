---
paths:
  - "n8n/**"
---
# n8n workflow rules

- Workflows are JSON in `n8n/workflows`, numbered as in the spec. Edit in the n8n UI, then run `./scripts/export-workflows.sh`; don't hand-write large node graphs.
- No credentials or tokens inside workflow JSON. Use n8n credentials or env vars.
- Every webhook node verifies its source (PayPal signature, Telegram chat ID) before any write.
- Every AI call goes through `07_ai_router`; never call a model provider directly from another workflow.
- Workflows must be safe to re-run: use idempotency keys and check status before acting.
