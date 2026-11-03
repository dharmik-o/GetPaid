import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/lib/runner";
import { openPglite, type TestDatabase } from "./pglite";

let handle: TestDatabase;
let dir: string;

beforeEach(async () => {
  handle = await openPglite();
  dir = await mkdtemp(join(tmpdir(), "fpr-migrations-"));
});

afterEach(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

const tableExists = async (name: string): Promise<boolean> => {
  const { rows } = await handle.db.query<{ found: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS found",
    [name],
  );
  return rows[0]?.found === true;
};

describe("migrate", () => {
  it("rolls back a failing migration and leaves it unrecorded", async () => {
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE ok_table (id int);");
    await writeFile(
      join(dir, "002_bad.sql"),
      "CREATE TABLE half_done (id int); SELECT * FROM missing_table;",
    );

    await expect(migrate(handle.db, dir)).rejects.toThrow(
      /002_bad\.sql failed and was rolled back/,
    );

    const { rows } = await handle.db.query<{ name: string }>(
      "SELECT name FROM public.schema_migrations",
    );
    expect(rows.map((row) => row.name)).toEqual(["001_ok.sql"]);
    expect(await tableExists("ok_table")).toBe(true);
    expect(await tableExists("half_done")).toBe(false);
  });

  it("hides schema_migrations behind row-level security", async () => {
    await migrate(handle.db, dir);
    const { rows } = await handle.db.query<{ rls: boolean }>(
      "SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.schema_migrations'::regclass",
    );
    expect(rows[0]?.rls).toBe(true);
  });
});
