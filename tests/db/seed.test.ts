import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUsualDaysLate } from "@/lib/account";
import { DEMO_USER_ID } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import { runAsUser, type Db } from "@/lib/db";
import { listMilestones } from "@/lib/milestones";
import { getProject } from "@/lib/projects";
import { settingsOverrideSchema } from "@/lib/settings";
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

  describe("the $3,000 website project", () => {
    const CLIENT = "00000000-0000-4000-8000-0000000000c1";
    const PROJECT = "00000000-0000-4000-8000-0000000000d1";
    const asDemo = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, DEMO_USER_ID, work);

    it("is for a New York client, as the demo plan says", async () => {
      const client = await asDemo((db) => getClient(db, CLIENT));
      expect(client).toMatchObject({ timeZone: "America/New_York", country: "US" });
    });

    it("has three milestones: USD 900 deposit, then 1,500 and 600, adding up to the total", async () => {
      const milestones = await asDemo(async (db) => {
        const project = await getProject(db, PROJECT);
        if (!project) throw new Error("The seeded project is missing.");
        expect(project).toMatchObject({ title: "Website redesign", totalCents: 300000 });
        return listMilestones(db, project);
      });
      expect(milestones.map((m) => [m.name, m.cents, m.paymentMode])).toEqual([
        ["Design", 90000, "deposit"],
        ["Build", 150000, "pay_on_invoice"],
        ["Launch", 60000, "pay_on_invoice"],
      ]);
    });

    it("schedules Net 7, every 3 days, 9:00 to 17:00, with settings the app accepts", async () => {
      const { rows } = await handle.db.query<{ settings: unknown }>(
        "SELECT settings FROM public.projects WHERE id = $1",
        [PROJECT],
      );
      const settings = settingsOverrideSchema.parse(rows[0]?.settings);
      expect(settings).toMatchObject({
        paymentTerms: { kind: "net", days: 7 },
        interval: { kind: "every", days: 3 },
        sendWindow: { start: "09:00", end: "17:00" },
      });
    });

    it("gives the demo a usual delay, and leaves one you've changed", async () => {
      await handle.db.query("UPDATE public.users SET usual_days_late = 12 WHERE id = $1", [
        DEMO_USER_ID,
      ]);
      await runSqlFile(handle.db, SEED_FILE);
      expect(await asDemo((db) => getUsualDaysLate(db))).toBe(12);
    });

    it("re-running leaves a changed project alone", async () => {
      await handle.db.query("UPDATE public.clients SET email = 'mine@example.test' WHERE id = $1", [
        CLIENT,
      ]);
      await runSqlFile(handle.db, SEED_FILE);
      const client = await asDemo((db) => getClient(db, CLIENT));
      expect(client?.email).toBe("mine@example.test");
    });
  });

  it("uses only reserved example domains for email addresses", () => {
    const emails = readFileSync(SEED_FILE, "utf8").match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((email) => /@example\.(test|com|org)$/.test(email))).toBe(true);
  });
});
