import pg from "pg";
import { assertLocalDatabase } from "./lib/local-db";
import { AUTH_STUB_FILE, MIGRATIONS_DIR, SEED_FILE } from "./lib/paths";
import { migrate, runSqlFile } from "./lib/runner";
import { fromPg, type SqlClient } from "./lib/sql-client";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const COMMANDS = {
  migrate: async (db: SqlClient): Promise<void> => {
    const applied = await migrate(db, MIGRATIONS_DIR);
    for (const name of applied) say(`applied ${name}`);
    say(
      applied.length === 0
        ? "database is up to date"
        : `${String(applied.length)} migration(s) applied`,
    );
  },
  seed: async (db: SqlClient): Promise<void> => {
    await runSqlFile(db, SEED_FILE);
    say("seed data loaded");
  },
  "dev-auth": async (db: SqlClient): Promise<void> => {
    await runSqlFile(db, AUTH_STUB_FILE);
    say("dev auth stub applied (auth.uid(), anon, authenticated, service_role)");
  },
} as const;

type Command = keyof typeof COMMANDS;

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && Object.hasOwn(COMMANDS, value);

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (!isCommand(command)) {
    throw new Error(
      `Unknown command "${command ?? ""}". Use: tsx scripts/db.ts ${Object.keys(COMMANDS).join("|")}`,
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your local env file (see .env.example), then run the command again.",
    );
  }
  if (command === "dev-auth") assertLocalDatabase(connectionString);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await COMMANDS[command](fromPg(client));
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
