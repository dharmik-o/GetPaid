import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertLocalDatabase } from "../../scripts/lib/local-db";
import { AUTH_STUB_FILE, MIGRATIONS_DIR } from "../../scripts/lib/paths";
import { migrate, runSqlFile } from "../../scripts/lib/runner";
import { fromPg } from "../../scripts/lib/sql-client";
import type { TestDatabase } from "./pglite";
import { defineRlsIsolationSuite } from "./rls-isolation.suite";

const connect = async (connectionString: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
};

/** Creates a throwaway database on the local Docker Postgres, migrates it, and drops it on close. */
const openDockerDatabase = async (): Promise<TestDatabase> => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Start the stack (docker compose up -d --wait) and run npm run test:db:docker.",
    );
  }
  assertLocalDatabase(url);
  const name = `fpr_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = await connect(url);
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const client = await connect(target.toString());
  const close = async (): Promise<void> => {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  };
  try {
    const db = fromPg(client);
    await runSqlFile(db, AUTH_STUB_FILE);
    await migrate(db, MIGRATIONS_DIR);
    return { db, close };
  } catch (error) {
    await close();
    throw error;
  }
};

defineRlsIsolationSuite("Docker Postgres", openDockerDatabase);
