import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { projectHandlers } from "@/lib/project-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

let handle: TestDatabase;

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const asA = projectHandlers({ runAsUser: runnerFor(USER_A.userId) });

const jsonRequest = (method: string, body: unknown): Request =>
  new Request("http://127.0.0.1:3000/api/projects", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type Issue = { field: string; message: string };
type ProjectBody = {
  project: {
    id: string;
    clientId: string;
    clientName: string;
    clientTimeZone: string;
    title: string;
    totalCents: number;
    currency: string;
    deadline: string;
    contractTerms: string | null;
    lateFeeClause: string | null;
    settings: Record<string, unknown>;
    inherited: Record<string, unknown>;
    status: string;
  };
  warnings: Issue[];
};
type ErrorBody = { error: string; errors?: Issue[] };

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const VALID = {
  clientId: "",
  title: "Website redesign",
  totalCents: 300000,
  currency: "USD",
  deadline: "2026-12-01",
};

const valid = (extra: Record<string, unknown> = {}) => ({
  ...VALID,
  clientId: USER_A.rows.clients,
  ...extra,
});

const createAsA = async (body: unknown): Promise<ProjectBody> => {
  const response = await asA.create(jsonRequest("POST", body));
  expect(response.status).toBe(201);
  return bodyOf<ProjectBody>(response);
};

const errorsOf = async (response: Response): Promise<Issue[]> => {
  expect(response.status).toBe(400);
  return (await bodyOf<ErrorBody>(response)).errors ?? [];
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.projects WHERE id NOT IN ($1, $2)", [
    USER_A.rows.projects,
    USER_B.rows.projects,
  ]);
  await handle.db.query("UPDATE public.clients SET settings = '{}'");
});

describe("POST /api/projects", () => {
  it("creates an active project for one of the user's clients", async () => {
    const { project, warnings } = await createAsA(valid({ contractTerms: "50% upfront" }));
    expect(project).toMatchObject({
      clientId: USER_A.rows.clients,
      clientName: "Client a",
      clientTimeZone: "America/New_York",
      title: "Website redesign",
      totalCents: 300000,
      currency: "USD",
      deadline: "2026-12-01",
      contractTerms: "50% upfront",
      lateFeeClause: null,
      settings: {},
      status: "active",
    });
    expect(project.inherited).toMatchObject({
      graceDays: 0,
      paymentTerms: { kind: "net", days: 14 },
    });
    expect(warnings).toEqual([]);
  });

  it("shows the account and client settings the project inherits", async () => {
    await handle.db.query("UPDATE public.users SET default_settings = $1 WHERE id = $2", [
      JSON.stringify({ maxPerTier: 4 }),
      USER_A.userId,
    ]);
    await handle.db.query("UPDATE public.clients SET settings = $1 WHERE id = $2", [
      JSON.stringify({ graceDays: 5 }),
      USER_A.rows.clients,
    ]);
    try {
      const { project } = await createAsA(valid());
      expect(project.inherited).toMatchObject({ graceDays: 5, maxPerTier: 4 });
    } finally {
      await handle.db.query("UPDATE public.users SET default_settings = '{}'");
    }
  });

  it("saves schedule overrides and warns, without blocking, when payment is due before the deadline", async () => {
    const settings = { paymentTerms: { kind: "date", date: "2026-11-20" } };
    const { project, warnings } = await createAsA(valid({ settings }));
    expect(project.settings).toEqual(settings);
    expect(warnings.map((w) => w.field)).toEqual(["settings.paymentTerms"]);
  });

  it("rejects invalid fields with a message for each", async () => {
    const errors = await errorsOf(
      await asA.create(
        jsonRequest("POST", {
          clientId: USER_A.rows.clients,
          title: " ",
          totalCents: 0,
          currency: "INR",
          deadline: "1 Dec",
        }),
      ),
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      "currency",
      "deadline",
      "title",
      "totalCents",
    ]);
  });

  it("rejects amounts that aren't whole minor units", async () => {
    const errors = await errorsOf(
      await asA.create(jsonRequest("POST", valid({ totalCents: 100.5 }))),
    );
    expect(errors.map((e) => e.field)).toEqual(["totalCents"]);
  });

  it("refuses another user's client, or a client id that isn't a UUID", async () => {
    for (const clientId of [USER_B.rows.clients, "not-a-uuid"]) {
      const errors = await errorsOf(await asA.create(jsonRequest("POST", valid({ clientId }))));
      expect(errors).toEqual([{ field: "clientId", message: "must be one of your clients" }]);
    }
  });

  it("allows a late fee only when the contract has a late-fee clause", async () => {
    const settings = { lateFee: { kind: "percent_per_month", basisPoints: 150 } };
    const errors = await errorsOf(await asA.create(jsonRequest("POST", valid({ settings }))));
    expect(errors.map((e) => e.field)).toEqual(["settings.lateFee"]);
    const { project } = await createAsA(
      valid({ settings, lateFeeClause: "1.5% per month on balances over 30 days late." }),
    );
    expect(project.settings).toEqual(settings);
  });

  it("only accepts JSON bodies", async () => {
    const form = new Request("http://127.0.0.1:3000/api/projects", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect((await asA.create(form)).status).toBe(415);
  });
});

describe("GET /api/projects/[id]", () => {
  it("returns the user's project and 404 for anyone else's", async () => {
    const { project } = await createAsA(valid());
    expect((await asA.get(new Request("http://x"), ctx(project.id))).status).toBe(200);
    expect((await asA.get(new Request("http://x"), ctx(USER_B.rows.projects))).status).toBe(404);
    expect((await asA.get(new Request("http://x"), ctx("nope"))).status).toBe(404);
  });
});

describe("PATCH /api/projects/[id]", () => {
  it("updates only the fields sent", async () => {
    const { project } = await createAsA(valid());
    const response = await asA.update(
      jsonRequest("PATCH", { title: "Website v2" }),
      ctx(project.id),
    );
    expect(response.status).toBe(200);
    const { project: updated } = await bodyOf<ProjectBody>(response);
    expect(updated).toMatchObject({
      title: "Website v2",
      totalCents: 300000,
      deadline: "2026-12-01",
    });
  });

  it("won't drop the late-fee clause while a late fee is still set", async () => {
    const { project } = await createAsA(
      valid({
        lateFeeClause: "2% per month.",
        settings: { lateFee: { kind: "flat", amountCents: 5000 } },
      }),
    );
    const errors = await errorsOf(
      await asA.update(jsonRequest("PATCH", { lateFeeClause: "" }), ctx(project.id)),
    );
    expect(errors.map((e) => e.field)).toEqual(["settings.lateFee"]);
  });

  it("can't change another user's project", async () => {
    const response = await asA.update(
      jsonRequest("PATCH", { title: "Mine now" }),
      ctx(USER_B.rows.projects),
    );
    expect(response.status).toBe(404);
  });
});
