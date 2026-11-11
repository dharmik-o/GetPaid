import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import pg from "pg";
import { DEMO_USER_ID } from "../../apps/web/src/lib/auth";
import { createSecretBox } from "../../apps/web/src/lib/crypto";
import { decodeEncryptionKey } from "../../apps/web/src/lib/encryption-key";
import { saveAiSettings } from "../../apps/web/src/lib/ai-settings";
import { runAsUser } from "../../apps/web/src/lib/db";
import { TIP_KEYS } from "../../apps/web/src/lib/tour-steps";
import { saveGmailConnection } from "../../apps/web/src/lib/gmail-account";
import { assertLocalDatabase } from "../../scripts/lib/local-db";
import { AUTH_STUB_FILE, MIGRATIONS_DIR, SEED_FILE } from "../../scripts/lib/paths";
import { migrate, runSqlFile } from "../../scripts/lib/runner";
import { fromPg } from "../../scripts/lib/sql-client";
import { FAKE_GMAIL_ADDRESS, FAKE_REFRESH_TOKEN } from "../mocks/gmail";
import { ARCHIVE_DIR, DATABASE_URL, DB_PORT, ENCRYPTION_KEY, TELEGRAM_CHAT_ID } from "./env";

// A brand new database for every run: its own container on its own port, in memory, so a run can't
// touch your dev data. Then the real migrations and seed, and the connections a presenter would
// have made by hand: Gmail, Telegram and a cloud model, all faked at the network.

const startDatabase = (): void => {
  execFileSync("docker", ["rm", "-f", "fpr-e2e-postgres"], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      "fpr-e2e-postgres",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--publish",
      `127.0.0.1:${String(DB_PORT)}:5432`,
      "--env",
      "POSTGRES_USER=e2e",
      "--env",
      "POSTGRES_PASSWORD=e2e-only",
      "--env",
      "POSTGRES_DB=e2e",
      "--env",
      "TZ=UTC",
      "postgres:17-alpine",
    ],
    { stdio: "ignore" },
  );
};

const connect = async (): Promise<pg.Client> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return client;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("The E2E database didn't start within 30 seconds. Is Docker running?");
};

const connectServices = async (client: pg.Client): Promise<void> => {
  const db = fromPg(client);
  const box = createSecretBox(decodeEncryptionKey(ENCRYPTION_KEY));
  await db.query("UPDATE public.users SET telegram_chat_id = $1 WHERE id = $2", [
    TELEGRAM_CHAT_ID,
    DEMO_USER_ID,
  ]);
  // The tour would cover every page the other specs click on; tour.spec.ts starts it by hand.
  await db.query(
    "UPDATE public.users SET tour_skipped_at = now(), tour_tips_seen = $1 WHERE id = $2",
    [[...TIP_KEYS], DEMO_USER_ID],
  );
  await saveGmailConnection(db, {
    userId: DEMO_USER_ID,
    refreshToken: FAKE_REFRESH_TOKEN,
    email: FAKE_GMAIL_ADDRESS,
    box,
  });
  const saved = await runAsUser(db, DEMO_USER_ID, (asUser) =>
    saveAiSettings(
      asUser,
      {
        main: {
          provider: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          model: "claude-sonnet-5-5",
          apiKey: "e2e-not-a-real-key",
        },
        cloudFallback: null,
      },
      box,
    ),
  );
  if (!saved.ok)
    throw new Error(`The E2E AI settings were refused: ${JSON.stringify(saved.errors)}`);
};

const globalSetup = async (): Promise<() => void> => {
  rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  assertLocalDatabase(DATABASE_URL);
  startDatabase();
  const client = await connect();
  const db = fromPg(client);
  await runSqlFile(db, AUTH_STUB_FILE);
  await migrate(db, MIGRATIONS_DIR);
  await runSqlFile(db, SEED_FILE);
  await connectServices(client);
  await client.end();
  return () => {
    execFileSync("docker", ["rm", "-f", "fpr-e2e-postgres"], { stdio: "ignore" });
  };
};

export default globalSetup;
