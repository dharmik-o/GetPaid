# QA status board

One row per step. Both builder and tester update it (see `docs/PARALLEL-WORKFLOW.md`). Solo mode: one session does both, on the main folder.

| Step | Branch | Built | QA | Merged | Notes |
| --- | --- | --- | --- | --- | --- |
| D1 | feat/D1-optional-components | done 9 Nov | pass 9 Nov (solo) | yes | check green, E2E 135 passed |
| D2 | feat/D2-prod-containers | done 9 Nov | pass 9 Nov (solo) | yes | check green, E2E 135 passed, stack checked on a throwaway project |
| D3 | feat/D3-demo-gate | done 9 Nov | pass 9 Nov (solo) | yes | check green, E2E 135 passed, gate checked live through Caddy |
| D4 | feat/D4-runbook | done 9 Nov | pass 9 Nov (solo) | yes | check green, E2E 135 passed; update.sh and server-setup.sh not run (need the server) |
| P0 | feat/P0-prep | done 9 Nov | pass 9 Nov (solo) | yes | docs and .env.example only; check green, E2E 135 passed |
| A1 | feat/A1-calendar-data | done 9 Nov | pass 9 Nov (solo) | yes | check green (2476 tests), E2E 135 passed |
| A2 | feat/A2-calendar-screens | done 9 Nov | pass 9 Nov (solo) | yes | check green; E2E 134 passed + more-menu spec fixed and rerun (15 pass); screens driven by a throwaway Playwright run |
| A3 | feat/A3-export | done 9 Nov | pass 9 Nov (solo) | yes | check green (2487 tests), E2E 136 passed; Outlook link and Google import unverified (owner) |
| A4 | feat/A4-calendar-import | done 9 Nov | pass 9 Nov (solo) | yes | check green (2534 tests), E2E 136 passed; Google secret address and n8n workflow need the owner |
| A5 | feat/A5-ai-assistant | done 9 Nov | pass 9 Nov (solo) | yes | check green (2557 tests), E2E 136 passed; a run with a real model needs the owner |
