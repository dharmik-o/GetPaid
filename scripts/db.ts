import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { orderMigrations, pendingMigrations } from "./lib/migrations";

const DB_DIR = join(import.meta.dirname, "..", "db");
const MIGRATIONS_DIR = join(DB_DIR, "migrations");
// Fixed key for pg_advisory_lock so two runners never apply migrations at once.
const MIGRATION_LOCK_ID = 727_001;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const connect = async (): Promise<pg.Client> => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your local env file (see .env.example), then run the command again.",
    );
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
};

const inTransaction = async (client: pg.Client, work: () => Promise<void>): Promise<void> => {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const appliedMigrations = async (client: pg.Client): Promise<Set<string>> => {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const result = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(result.rows.map((row) => row.name));
};

const applyMigration = async (client: pg.Client, name: string): Promise<void> => {
  const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
  try {
    await inTransaction(client, async () => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Migration ${name} failed and was rolled back: ${reason}. Fix the SQL, then run npm run db:migrate again.`,
      { cause: error },
    );
  }
  say(`applied ${name}`);
};

const migrate = async (client: pg.Client): Promise<void> => {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    const ordered = orderMigrations(await readdir(MIGRATIONS_DIR));
    const pending = pendingMigrations(ordered, await appliedMigrations(client));
    for (const name of pending) await applyMigration(client, name);
    say(
      pending.length === 0
        ? "database is up to date"
        : `${String(pending.length)} migration(s) applied`,
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }
};

const seed = async (client: pg.Client): Promise<void> => {
  const sql = await readFile(join(DB_DIR, "seed.sql"), "utf8");
  await inTransaction(client, async () => {
    await client.query(sql);
  });
  say("seed data loaded");
};

const COMMANDS = { migrate, seed } as const;

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (command !== "migrate" && command !== "seed") {
    throw new Error(`Unknown command "${command ?? ""}". Use: tsx scripts/db.ts migrate|seed`);
  }
  const client = await connect();
  try {
    await COMMANDS[command](client);
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
