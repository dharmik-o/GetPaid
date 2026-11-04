import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { assertLocalDatabase } from "./lib/local-db";
import { fromPg, type SqlClient } from "./lib/sql-client";
import {
  createTestDraft,
  deliveryStage,
  linkedUserId,
  readTestDraft,
  removeTestDraft,
  type DeliveryStage,
  type TestDraftRow,
} from "./lib/telegram-test-draft";

// Live check of the Telegram approval card, against your real bot. n8n collects cards once a
// minute, so this waits long enough for two runs before calling it stuck.

const WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 3000;

const NOT_LINKED =
  "Your Telegram chat isn't linked. In Settings > Integrations press Connect Telegram, open the link and press Start, then run this again.";

const STUCK: Readonly<Record<Exclude<DeliveryStage, "delivered">, string>> = {
  not_collected:
    'FAILED: n8n never collected the card. Check that the dev server is running and that "Approval handler" is active in n8n, with INTERNAL_API_TOKEN matching its "Header Auth account" credential.',
  handed_over:
    'FAILED: n8n collected the card, but Telegram didn\'t confirm it. Open "Approval handler" > Executions in n8n and read the failed "Send card" or "Report the card" step. n8n retries the card about 10 minutes later.',
};

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const tapResult = (row: TestDraftRow): string => {
  if (row.approvalStatus !== "waiting") return `Your tap was recorded: ${row.approvalStatus}.`;
  if (row.editing)
    return "Edit was tapped: the bot is waiting for you to reply with what to change.";
  return "Still waiting for you to tap Approve, Edit or Skip.";
};

const waitForCard = async (db: SqlClient): Promise<DeliveryStage> => {
  const giveUpAt = Date.now() + WAIT_MS;
  let seen: DeliveryStage = "not_collected";
  while (Date.now() < giveUpAt) {
    const row = await readTestDraft(db);
    if (!row) throw new Error("The test draft has gone: something removed it during the check.");
    const stage = deliveryStage(row);
    if (stage === "delivered") return stage;
    if (stage !== seen) say("n8n collected the card. Waiting for Telegram to confirm...");
    seen = stage;
    await sleep(POLL_MS);
  }
  return seen;
};

const run = async (db: SqlClient): Promise<void> => {
  const userId = await linkedUserId(db);
  if (!userId) {
    say(`FAILED: ${NOT_LINKED}`);
    process.exitCode = 1;
    return;
  }
  say("Your Telegram chat is linked.");
  await createTestDraft(db, userId, new Date());
  say('Test draft created for "Test Client (fake)". No email can go out for it.');
  say("Waiting for n8n, which collects cards once a minute...");
  const stage = await waitForCard(db);
  if (stage !== "delivered") {
    say(STUCK[stage]);
    process.exitCode = 1;
    return;
  }
  say("PASSED: Telegram confirmed the card. Check your phone, then tap Approve, Edit or Skip.");
  say("See what your tap did: npm run telegram:test -- status");
  say("Remove the test draft: npm run telegram:test -- remove");
};

const status = async (db: SqlClient): Promise<void> => {
  const row = await readTestDraft(db);
  if (!row) {
    say("There's no test draft. Create one with: npm run telegram:test");
    return;
  }
  const stage = deliveryStage(row);
  say(stage === "delivered" ? tapResult(row) : `The card isn't delivered yet (${stage}).`);
};

const remove = async (db: SqlClient): Promise<void> => {
  say((await removeTestDraft(db)) ? "Test draft removed." : "There was no test draft to remove.");
};

const COMMANDS = { run, status, remove } as const;

const main = async (): Promise<void> => {
  const name = process.argv[2] ?? "run";
  if (name !== "run" && name !== "status" && name !== "remove") {
    throw new Error(`Unknown command "${name}". Use: npm run telegram:test -- status|remove`);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your local env file (see .env.example), then run the command again.",
    );
  }
  // The draft is fake data and belongs in a local database only.
  assertLocalDatabase(connectionString);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await COMMANDS[name](fromPg(client));
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
