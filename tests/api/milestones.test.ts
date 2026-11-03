import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { milestoneHandlers } from "@/lib/milestone-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

let handle: TestDatabase;

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const asA = milestoneHandlers({ runAsUser: runnerFor(USER_A.userId) });

/** A second project for user A with no invoices, so its plan can change freely. */
const FREE_PROJECT = "aaaaaaaa-0000-4000-8000-0000000000ff";

type Issue = { field: string; message: string };
type Milestone = {
  id: string;
  position: number;
  name: string;
  amountCents: number | null;
  percentBp: number | null;
  cents: number;
  deadline: string;
  paymentMode: string;
  status: string;
};
type PlanBody = { milestones: Milestone[]; warnings: Issue[] };

const put = (projectId: string, milestones: unknown[]) =>
  asA.savePlan(
    new Request("http://127.0.0.1:3000/api/projects/x/milestones", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestones }),
    }),
    { params: Promise.resolve({ id: projectId }) },
  );

const patchStatus = (milestoneId: string, status: string) =>
  asA.markStatus(
    new Request("http://127.0.0.1:3000/api/milestones/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: milestoneId }) },
  );

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const errorsOf = async (response: Response): Promise<Issue[]> => {
  expect(response.status).toBe(400);
  return (await bodyOf<{ errors?: Issue[] }>(response)).errors ?? [];
};

const DEMO_PLAN = [
  { name: "Design", percentBp: 3000, deadline: "2026-12-01", paymentMode: "deposit" },
  { name: "Build", percentBp: 5000, deadline: "2026-12-15" },
  { name: "Launch", percentBp: 2000, deadline: "2026-12-22" },
];

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
     VALUES ($1, $2, $3, 'Free project', 300000, 'USD', '2026-12-31')`,
    [FREE_PROJECT, USER_A.userId, USER_A.rows.clients],
  );
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.milestones WHERE project_id = $1", [FREE_PROJECT]);
});

describe("PUT /api/projects/[id]/milestones", () => {
  it("saves the $3,000 demo plan with amounts worked out from the percentages", async () => {
    const response = await put(FREE_PROJECT, DEMO_PLAN);
    expect(response.status).toBe(200);
    const { milestones, warnings } = await bodyOf<PlanBody>(response);
    expect(milestones.map((m) => [m.position, m.name, m.cents, m.paymentMode, m.status])).toEqual([
      [1, "Design", 90000, "deposit", "planned"],
      [2, "Build", 150000, "pay_on_invoice", "planned"],
      [3, "Launch", 60000, "pay_on_invoice", "planned"],
    ]);
    expect(warnings).toEqual([]);
  });

  it("updates milestones in place by id, including a new order", async () => {
    const first = await bodyOf<PlanBody>(await put(FREE_PROJECT, DEMO_PLAN));
    const [design, build, launch] = first.milestones;
    const response = await put(FREE_PROJECT, [
      { id: build?.id, name: "Build v2", percentBp: 5000, deadline: "2026-12-15" },
      { id: design?.id, name: "Design", percentBp: 3000, deadline: "2026-12-16" },
      { id: launch?.id, name: "Launch", percentBp: 2000, deadline: "2026-12-22" },
    ]);
    const { milestones } = await bodyOf<PlanBody>(response);
    expect(milestones.map((m) => [m.id, m.position, m.name])).toEqual([
      [build?.id, 1, "Build v2"],
      [design?.id, 2, "Design"],
      [launch?.id, 3, "Launch"],
    ]);
  });

  it("rejects a plan that doesn't add up to the project total", async () => {
    const errors = await errorsOf(
      await put(FREE_PROJECT, [{ name: "A", amountCents: 100000, deadline: "2026-12-01" }]),
    );
    expect(errors.map((e) => e.field)).toEqual(["milestones"]);
  });

  it("warns, without blocking, about deadlines out of order", async () => {
    const response = await put(FREE_PROJECT, [
      { name: "Design", percentBp: 3000, deadline: "2026-12-10" },
      { name: "Build", percentBp: 7000, deadline: "2026-12-05" },
    ]);
    expect(response.status).toBe(200);
    expect((await bodyOf<PlanBody>(response)).warnings.map((w) => w.field)).toEqual([
      "milestones.1.deadline",
    ]);
  });

  it("needs exactly one of amount or percentage per milestone", async () => {
    const both = await errorsOf(
      await put(FREE_PROJECT, [
        { name: "A", amountCents: 300000, percentBp: 10000, deadline: "2026-12-01" },
      ]),
    );
    expect(both.map((e) => e.field)).toEqual(["milestones.0.amountCents"]);
    const neither = await errorsOf(
      await put(FREE_PROJECT, [{ name: "A", deadline: "2026-12-01" }]),
    );
    expect(neither.map((e) => e.field)).toEqual(["milestones.0.amountCents"]);
  });

  it("reports invalid fields by milestone and field", async () => {
    const errors = await errorsOf(
      await put(FREE_PROJECT, [
        {
          name: "",
          percentBp: 10000,
          deadline: "soon",
          paymentMode: "barter",
          acceptanceWindowDays: -1,
        },
      ]),
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      "milestones.0.acceptanceWindowDays",
      "milestones.0.deadline",
      "milestones.0.name",
      "milestones.0.paymentMode",
    ]);
  });

  it("checks each milestone's schedule overrides against the project's contract", async () => {
    const errors = await errorsOf(
      await put(FREE_PROJECT, [
        {
          name: "All",
          percentBp: 10000,
          deadline: "2026-12-01",
          settings: { lateFee: { kind: "flat", amountCents: 1000 } },
        },
      ]),
    );
    expect(errors.map((e) => e.field)).toEqual(["milestones.0.settings.lateFee"]);
  });

  it("accepts an empty plan, removing milestones that haven't been invoiced", async () => {
    await put(FREE_PROJECT, DEMO_PLAN);
    const response = await put(FREE_PROJECT, []);
    expect(response.status).toBe(200);
    expect((await bodyOf<PlanBody>(response)).milestones).toEqual([]);
  });

  describe("milestones with an invoice", () => {
    // The seeded milestone (Design, 30%) has an invoice row.
    const seeded = {
      id: USER_A.rows.milestones,
      name: "Design",
      percentBp: 3000,
      deadline: "2026-12-01",
    };
    const rest = [
      { name: "Build", percentBp: 5000, deadline: "2026-12-15" },
      { name: "Launch", percentBp: 2000, deadline: "2026-12-22" },
    ];

    it("can keep their amount and get renamed", async () => {
      const response = await put(USER_A.rows.projects, [
        { ...seeded, name: "Design phase" },
        ...rest,
      ]);
      expect(response.status).toBe(200);
    });

    it("can't have their share changed", async () => {
      const errors = await errorsOf(
        await put(USER_A.rows.projects, [
          { ...seeded, percentBp: 4000 },
          { name: "Build", percentBp: 6000, deadline: "2026-12-15" },
        ]),
      );
      expect(errors).toEqual([
        {
          field: "milestones.0.percentBp",
          message: "can't change once the milestone has an invoice. Cancel the invoice first.",
        },
      ]);
    });

    it("can't be removed", async () => {
      const errors = await errorsOf(
        await put(USER_A.rows.projects, [
          { name: "All", percentBp: 10000, deadline: "2026-12-01" },
        ]),
      );
      expect(errors).toEqual([
        {
          field: "milestones",
          message: "Design phase has an invoice, so it can't be removed. Cancel the invoice first.",
        },
      ]);
    });
  });

  it("rejects a milestone id from another project", async () => {
    const errors = await errorsOf(
      await put(FREE_PROJECT, [
        { id: USER_B.rows.milestones, name: "X", percentBp: 10000, deadline: "2026-12-01" },
      ]),
    );
    expect(errors.map((e) => e.field)).toEqual(["milestones.0.id"]);
  });

  it("answers 404 for another user's project", async () => {
    expect((await put(USER_B.rows.projects, DEMO_PLAN)).status).toBe(404);
  });
});

describe("PATCH /api/milestones/[id]", () => {
  it("moves work forward one step at a time", async () => {
    const { milestones } = await bodyOf<PlanBody>(await put(FREE_PROJECT, DEMO_PLAN));
    const id = milestones[0]?.id ?? "";
    const response = await patchStatus(id, "in_progress");
    expect(response.status).toBe(200);
    expect((await bodyOf<{ milestone: Milestone }>(response)).milestone.status).toBe("in_progress");
    expect(await errorsOf(await patchStatus(id, "accepted"))).toEqual([
      {
        field: "status",
        message: "can't go from In progress to Accepted. Mark it Delivered first.",
      },
    ]);
  });

  it("never lets a person mark a milestone paid", async () => {
    const { milestones } = await bodyOf<PlanBody>(await put(FREE_PROJECT, DEMO_PLAN));
    const errors = await errorsOf(await patchStatus(milestones[0]?.id ?? "", "paid"));
    expect(errors[0]?.field).toBe("status");
  });

  it("answers 404 for another user's milestone", async () => {
    expect((await patchStatus(USER_B.rows.milestones, "in_progress")).status).toBe(404);
  });
});
