import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_USER_ID } from "@/lib/auth";
import { SEED_FILE } from "../../scripts/lib/paths";
import { runSqlFile } from "../../scripts/lib/runner";
import { openMigratedPglite, type TestDatabase } from "./pglite";

describe("db/seed.sql", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await openMigratedPglite();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it("creates the demo freelancer the dashboard acts as in development, and can run twice", async () => {
    await runSqlFile(handle.db, SEED_FILE);
    await runSqlFile(handle.db, SEED_FILE);
    const { rows } = await handle.db.query<{ id: string; email: string }>(
      "SELECT id::text, email FROM public.users",
    );
    expect(rows).toEqual([{ id: DEMO_USER_ID, email: "demo.freelancer@example.test" }]);
  });

  it("uses only reserved example domains for email addresses", () => {
    const emails = readFileSync(SEED_FILE, "utf8").match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((email) => /@example\.(test|com|org)$/.test(email))).toBe(true);
  });
});
