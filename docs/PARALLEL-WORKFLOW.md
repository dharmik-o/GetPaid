# Parallel workflow: a builder and a tester on separate branches

Two Claude Code sessions work at the same time on one computer:

- **Builder:** builds the next step of a plan (`docs/DEPLOY-PLAN.md`, then `docs/PHASE2-PLAN.md`) on its own branch.
- **Tester:** checks the previous step on that step's branch: runs the checks, reviews the code against the plan's rules, fixes what's broken, and merges it into `main` when it passes.

They never work on the same branch, folder, database, port or n8n at the same time. The owner starts both sessions and settles anything the rules below say to stop for.

---

## 1. The layout

| | Builder | Tester |
| --- | --- | --- |
| Folder | the main repo folder | a second folder made with `git worktree` (`../getpaid-qa`) |
| Branch | `feat/<step>-<slug>`, e.g. `feat/A2-calendar-screens` | the branch of the step under test, e.g. `feat/A1-calendar-data` |
| Database | the normal dev database (`DATABASE_URL`) | a separate database, `getpaid_qa` (`DATABASE_URL` in the QA folder's `.env` points at it) |
| Dev server | port 3000 | port 3001 (`PORT=3001`), and Playwright pointed at it (`PLAYWRIGHT_BASE_URL=http://localhost:3001` or the config's equivalent) |
| n8n, Telegram, Gmail, PayPal live calls | allowed when a step needs them | **never**: tests use msw mocks only; the tester doesn't run `n8n:go-live`, `telegram:test`, `gmail:test` or `hold:check` |
| Writes code for | the new step | fixes in the step under test, each with a failing test first |

## 2. One-time setup (the owner)

```bash
# From the main repo folder, with your work committed:
git worktree add ../getpaid-qa main
cd ../getpaid-qa
copy ..\freelancer-payment-recovery\.env .env       # Windows; on macOS/Linux: cp ../freelancer-payment-recovery/.env .env
# Edit ../getpaid-qa/.env yourself: change the database name in DATABASE_URL to getpaid_qa, add PORT=3001
npm install
docker compose exec postgres createdb -U <POSTGRES_USER> getpaid_qa
npm run db:dev-auth && npm run db:migrate && npm run db:seed     # in the QA folder, against getpaid_qa
```

Only the owner copies and edits `.env` (the agents are not allowed to read it).

## 3. The status board: `docs/qa/STATUS.md`

Both agents read it at the start and update it at the end of every session. One row per step:

```markdown
| Step | Branch | Built | QA | Merged | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | feat/A1-calendar-data | done 10 Nov | pass 10 Nov | yes | |
| A2 | feat/A2-calendar-screens | done 11 Nov | in progress | | |
| A3 | feat/A3-export | building | | | stacked on A2 |
```

QA findings go in `docs/qa/<step>.md`: what was checked, what failed, what was fixed (commit), and anything the owner must decide.

## 4. The builder's rules

1. Start each step from the newest `main`: `git switch main`, then `git switch -c feat/<step>-<slug>`. If the previous step isn't merged yet, branch from **its** branch instead ("stacked"), and write "stacked on <step>" in the board.
2. Build only that step, exactly as the plan says. Commit on that branch. Never commit to `main`, never merge, never touch a branch that's under QA.
3. When done: `npm run check` green, the step's tests written, the board updated to "Built: done", then stop.
4. When the tester has merged the step you stacked on: `git rebase main` on your branch. If the rebase has conflicts, stop and tell the owner; don't guess.

## 5. The tester's rules

1. In `../getpaid-qa`: `git fetch` isn't needed (same repo); `git switch feat/<step>-<slug>` for the oldest step marked "Built: done" and not yet merged. Set the board to "QA: in progress".
2. Run, in order:
   - `npm run db:migrate` (against `getpaid_qa`)
   - `npm run check`
   - `npm run test:e2e` (dev server on port 3001)
   - Review the step's diff (`git diff main...HEAD`) against: the plan's section 2 rules, the step's "Done when", the file map, and the step's "Don'ts". Look especially for: anything logged that shouldn't be, service role used outside the allowed places, missing RLS, AI output used without the code checks, amounts as floats, secrets returned to the browser, and missing approval before sending.
3. If something fails: write a failing test that shows it, fix it on the **same** feature branch, commit as `fix(<area>): <what>`, and record it in `docs/qa/<step>.md`. If the fix needs a decision about money, legal text or security, stop and ask the owner instead.
4. When everything passes: update the board to "QA: pass", then merge:
   ```bash
   git switch main
   git merge --no-ff feat/<step>-<slug> -m "merge: <step> <slug>"
   npm run check
   ```
   If the merge has conflicts or `check` fails after merging, undo it with `git merge --abort` (or `git reset --hard ORIG_HEAD` right after a failed merge commit, only on `main` in the QA folder) and tell the owner. Then set "Merged: yes" and tell the builder (through the board) to rebase.
5. Never start new features. Never push (pushing is the owner's job).

## 6. Prompts

**Builder session** (main folder):

```
You are the BUILDER. Read docs/PARALLEL-WORKFLOW.md and docs/qa/STATUS.md, then the plan file. Build the next unbuilt step on its own branch, following the builder's rules exactly. Stop when the step is built, checked and recorded on the board.
```

**Tester session** (`../getpaid-qa` folder):

```
You are the TESTER. Read docs/PARALLEL-WORKFLOW.md and docs/qa/STATUS.md, then the plan file. Test the oldest step that is built and not merged, following the tester's rules exactly: check, review against the plan, fix with failing tests first, then merge into main if it passes. Record everything in docs/qa/<step>.md and on the board, then stop.
```

## 7. When not to run in parallel

- Steps that change the **same migration or the same files** as the step under test (for example C2 while C1 is still in QA, since both touch `028_contracts.sql`): the builder waits, or stacks and expects a rebase.
- Live checks with real services (Telegram, Gmail, PayPal, the Oracle server): the builder does them alone, with the tester stopped.
- If the lower-level model struggles with rebases or conflicts, fall back to one session at a time: build a step, then test it in a fresh session on the same branch, then merge.

## 8. Cost

Two sessions use roughly twice the tokens. To save: run the tester at medium effort, and give it only the steps marked security-heavy in the plan (A4, A5, C1, C3, C4); for the others, the builder's own `npm run check` plus a quick owner look may be enough.
