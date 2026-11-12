import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_USER_ID } from "@/lib/auth";
import { runAsUser, type Db } from "@/lib/db";
import { loadMetrics } from "@/lib/metrics";
import { listMilestones } from "@/lib/milestones";
import { listOutbox } from "@/lib/outbox";
import { getProject } from "@/lib/projects";
import { listPendingReplies } from "@/lib/reply-review";
import { settingsOverrideSchema } from "@/lib/settings";
import { SEED_FILE, SHOWCASE_FILE } from "../../scripts/lib/paths";
import { runSqlFile } from "../../scripts/lib/runner";
import { openMigratedPglite, type TestDatabase } from "./pglite";

// The public demo's showcase data: more clients and projects in every state, loaded after the seed.

const SHOWCASE_PROJECTS = [
  "00000000-0000-4000-8000-0000000000d2",
  "00000000-0000-4000-8000-0000000000d3",
  "00000000-0000-4000-8000-0000000000d4",
  "00000000-0000-4000-8000-0000000000d5",
];

describe("db/seed-showcase.sql", () => {
  let handle: TestDatabase;
  const asDemo = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, DEMO_USER_ID, work);
  const now = new Date();

  beforeAll(async () => {
    handle = await openMigratedPglite();
    await runSqlFile(handle.db, SEED_FILE);
    await runSqlFile(handle.db, SHOWCASE_FILE);
    await runSqlFile(handle.db, SHOWCASE_FILE);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it("adds four clients in four countries and currencies, once, beside the seed's client", async () => {
    const { rows } = await handle.db.query<{ country: string; currency: string }>(
      `SELECT c.country, p.currency FROM public.clients c
       JOIN public.projects p ON p.client_id = c.id ORDER BY c.created_at`,
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.currency))).toEqual(
      new Set(["USD", "EUR", "GBP", "AUD", "CAD"]),
    );
  });

  it("gives every project settings the app accepts and milestones that add up to its total", async () => {
    for (const id of SHOWCASE_PROJECTS) {
      const { rows } = await handle.db.query<{ settings: unknown }>(
        "SELECT settings FROM public.projects WHERE id = $1",
        [id],
      );
      expect(settingsOverrideSchema.safeParse(rows[0]?.settings).success).toBe(true);
      const total = await asDemo(async (db) => {
        const project = await getProject(db, id);
        if (!project) throw new Error(`Project ${id} is missing.`);
        const milestones = await listMilestones(db, project);
        return [project.totalCents, milestones.reduce((sum, m) => sum + m.cents, 0)];
      });
      expect(total[1]).toBe(total[0]);
    }
  });

  it("bills each invoice for exactly its milestone's amount", async () => {
    const { rows } = await handle.db.query<{
      amount: string;
      currency: string;
      total: string;
      bp: number;
      pc: string;
    }>(
      `SELECT i.amount_cents::text AS amount, i.currency, p.total_cents::text AS total, m.percent_bp AS bp,
         p.currency AS pc
       FROM public.invoices i JOIN public.milestones m ON m.id = i.milestone_id
       JOIN public.projects p ON p.id = m.project_id`,
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.currency).toBe(row.pc);
      expect(Number(row.amount)).toBe((Number(row.total) * row.bp) / 10_000);
    }
  });

  it("puts a first reminder and a final notice in the Outbox, each with its invoice's link", async () => {
    const waiting = await asDemo((db) => listOutbox(db, "waiting", now));
    expect(waiting.map((item) => [item.clientName, item.tier]).sort()).toEqual([
      ["Maple Leaf Media", "tier3"],
      ["Wattle Wellness", "tier1"],
    ]);
    for (const item of waiting) {
      expect(item.draft).not.toBeNull();
      expect(item.payLink).toBeTruthy();
      expect(item.draft?.body).toContain(item.payLink ?? "missing");
    }
    const notice = waiting.find((item) => item.tier === "tier3");
    expect(notice?.draft).toMatchObject({ citation: "contract", notLegalAdvice: true });
    expect(notice?.draft?.body).toContain("1.5% of the unpaid amount per month");
    const sent = await asDemo((db) => listOutbox(db, "sent", now));
    expect(sent).toHaveLength(4);
    expect(sent.every((item) => item.draft !== null)).toBe(true);
  });

  it("leaves one client reply, sorted as a promise, waiting in Replies", async () => {
    const replies = await asDemo((db) => listPendingReplies(db, now));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ clientName: "Harbour & Pine Architects" });
  });

  it("gives the home page late money recovered, per currency, and overdue invoices to chase", async () => {
    const metrics = await asDemo((db) => loadMetrics(db, now));
    expect(metrics.recovered.map((r) => r.currency).sort()).toEqual(["AUD", "EUR"]);
    expect(metrics.overdue.map((o) => o.clientName).sort()).toEqual([
      "Harbour & Pine Architects",
      "Maple Leaf Media",
      "Wattle Wellness",
    ]);
  });

  it("uses only reserved example domains for email addresses", () => {
    const emails = readFileSync(SHOWCASE_FILE, "utf8").match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((email) => /@example\.(test|com|org)$/.test(email))).toBe(true);
  });
});
