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
| C1 | feat/C1-facts-law-table | done 9 Nov | pass 9 Nov (solo) | yes | check green (2574 tests), E2E 136 passed; no law could be read from an official page, so `statutes.json` is empty and all 19 rates are unapproved (owner) |
| C2 | feat/C2-agreement-builder | done 9 Nov | pass 9 Nov (solo) | yes | check green (2593 tests), E2E 136 passed; builder driven in a browser; template needs a lawyer's review (owner) |
| C3 | feat/C3-signing | done 9 Nov | pass 9 Nov (solo) | yes | check green (2616 tests), E2E 136 passed; whole flow driven in a browser against fakes; real Gmail and APP_PUBLIC_URL need the owner |
| C4 | feat/C4-interest-final-demand | done 9 Nov | pass 9 Nov (solo) | yes | check green (2663 tests), E2E 136 passed; button, draft, approval and email driven in a browser against fakes; the MSMED method and the wording need the owner |
| C5 | feat/C5-lawyer-pack | done 9 Nov | pass 9 Nov (solo) | yes | check green (2673 tests), E2E 136 passed; download driven in a real browser with real Chromium; summary in docs/SUMMARY-P2-contracts.md |
| A6 | feat/A6-calendar-clicks | done 10 Nov | pass 10 Nov (solo) | yes | check green (2682 tests), E2E 137 passed; panel look (light/dark, phone) not seen by me, owner to look |
| R2 | feat/R2-stitch-restyle | done 10 Nov | pass 10 Nov (solo) | yes | check green (2682 tests), E2E 137 passed; screens compared with docs/design/stitch/ (docs/qa/R2.md). C8 was not on main (no branch or commit), so the timeline was restyled without its collapsible rows; Promise date chip and Adjust schedule not built (no data or form) |
