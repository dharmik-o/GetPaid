import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientHandlers } from "@/lib/client-handlers";
import type { UserDbRunner } from "@/lib/db";
import { runAsUser } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

let handle: TestDatabase;

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const asA = clientHandlers({ runAsUser: runnerFor(USER_A.userId) });
const asB = clientHandlers({ runAsUser: runnerFor(USER_B.userId) });

const jsonRequest = (method: string, body: unknown): Request =>
  new Request("http://127.0.0.1:3000/api/clients", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type ClientBody = {
  client: {
    id: string;
    name: string;
    email: string;
    country: string;
    countryName: string;
    timeZone: string;
    settings: Record<string, unknown>;
    openBalances: { currency: string; cents: number }[];
    lastActivityAt: string;
  };
};
type ErrorBody = { error: string; errors?: { field: string; message: string }[] };

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const createAsA = async (body: unknown): Promise<ClientBody["client"]> => {
  const response = await asA.create(jsonRequest("POST", body));
  expect(response.status).toBe(201);
  return (await bodyOf<ClientBody>(response)).client;
};

const VALID = { name: "Acme Studio", email: "billing@acme.example", country: "US" };

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  // Keep only the seeded client for each user.
  await handle.db.query("DELETE FROM public.clients WHERE id NOT IN ($1, $2)", [
    USER_A.rows.clients,
    USER_B.rows.clients,
  ]);
});

describe("POST /api/clients", () => {
  it("creates a client with the time zone taken from the country", async () => {
    const client = await createAsA(VALID);
    expect(client).toMatchObject({
      name: "Acme Studio",
      email: "billing@acme.example",
      country: "US",
      countryName: "United States of America",
      timeZone: "America/New_York",
      settings: {},
      openBalances: [],
    });
  });

  it("keeps a time zone the freelancer picked", async () => {
    const client = await createAsA({ ...VALID, timeZone: "America/Los_Angeles" });
    expect(client.timeZone).toBe("America/Los_Angeles");
  });

  it("trims names and saves valid schedule overrides", async () => {
    const client = await createAsA({ ...VALID, name: "  Acme  ", settings: { graceDays: 3 } });
    expect(client.name).toBe("Acme");
    expect(client.settings).toEqual({ graceDays: 3 });
  });

  it("rejects invalid fields with a message for each", async () => {
    const response = await asA.create(
      jsonRequest("POST", { name: " ", email: "nope", country: "XX", timeZone: "Mars/Olympus" }),
    );
    expect(response.status).toBe(400);
    const body = await bodyOf<ErrorBody>(response);
    expect(body.errors?.map((e) => e.field).sort()).toEqual([
      "country",
      "email",
      "name",
      "timeZone",
    ]);
    expect(body.errors?.find((e) => e.field === "country")?.message).toBe(
      "must be picked from the list",
    );
  });

  it("reports invalid schedule overrides under settings", async () => {
    const response = await asA.create(
      jsonRequest("POST", { ...VALID, settings: { graceDays: 99 } }),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf<ErrorBody>(response)).errors).toEqual([
      { field: "settings.graceDays", message: "must be 14 days or fewer" },
    ]);
  });

  it("rejects fields it doesn't know, such as an owner id", async () => {
    const response = await asA.create(jsonRequest("POST", { ...VALID, user_id: USER_B.userId }));
    expect(response.status).toBe(400);
    expect((await bodyOf<ErrorBody>(response)).errors).toEqual([
      { field: "user_id", message: "isn't a known field" },
    ]);
  });

  it("only accepts JSON bodies", async () => {
    const form = new Request("http://127.0.0.1:3000/api/clients", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Acme",
    });
    expect((await asA.create(form)).status).toBe(415);
  });

  it("rejects a body that isn't valid JSON", async () => {
    const broken = new Request("http://127.0.0.1:3000/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const response = await asA.create(broken);
    expect(response.status).toBe(400);
    expect((await bodyOf<ErrorBody>(response)).error).toMatch(/JSON/);
  });
});

describe("GET /api/clients", () => {
  it("lists only the signed-in user's clients, by name", async () => {
    await createAsA({ ...VALID, name: "Zeta Labs" });
    await createAsA({ ...VALID, name: "alpha co" });
    const response = await asA.list();
    const { clients } = await bodyOf<{ clients: ClientBody["client"][] }>(response);
    expect(clients.map((c) => c.name)).toEqual(["alpha co", "Client a", "Zeta Labs"]);
  });

  it("shows the open balance per currency, from sent and partly paid invoices", async () => {
    await handle.db.query(
      "UPDATE public.invoices SET status = 'partially_paid', amount_paid_cents = 30000 WHERE id = $1",
      [USER_A.rows.invoices],
    );
    try {
      const { clients } = await bodyOf<{ clients: ClientBody["client"][] }>(await asA.list());
      const seeded = clients.find((c) => c.id === USER_A.rows.clients);
      expect(seeded?.openBalances).toEqual([{ currency: "USD", cents: 60000 }]);
      expect(Number.isNaN(Date.parse(seeded?.lastActivityAt ?? ""))).toBe(false);
    } finally {
      await handle.db.query(
        "UPDATE public.invoices SET status = 'draft', amount_paid_cents = 0 WHERE id = $1",
        [USER_A.rows.invoices],
      );
    }
  });
});

describe("GET /api/clients/[id]", () => {
  it("returns the client", async () => {
    const created = await createAsA(VALID);
    const response = await asA.get(new Request("http://x"), ctx(created.id));
    expect(response.status).toBe(200);
    expect((await bodyOf<ClientBody>(response)).client.id).toBe(created.id);
  });

  it("answers 404 for another user's client, and for ids that aren't UUIDs", async () => {
    expect((await asA.get(new Request("http://x"), ctx(USER_B.rows.clients))).status).toBe(404);
    expect((await asA.get(new Request("http://x"), ctx("1 OR 1=1"))).status).toBe(404);
  });
});

describe("PATCH /api/clients/[id]", () => {
  it("updates only the fields sent", async () => {
    const created = await createAsA(VALID);
    const response = await asA.update(jsonRequest("PATCH", { name: "Acme Inc" }), ctx(created.id));
    expect(response.status).toBe(200);
    const { client } = await bodyOf<ClientBody>(response);
    expect(client).toMatchObject({
      name: "Acme Inc",
      email: VALID.email,
      timeZone: "America/New_York",
    });
  });

  it("moves the time zone to the new country's default when only the country changes", async () => {
    const created = await createAsA(VALID);
    const { client } = await bodyOf<ClientBody>(
      await asA.update(jsonRequest("PATCH", { country: "IN" }), ctx(created.id)),
    );
    expect(client).toMatchObject({ country: "IN", timeZone: "Asia/Kolkata" });
  });

  it("keeps the time zone sent with a country change", async () => {
    const created = await createAsA(VALID);
    const { client } = await bodyOf<ClientBody>(
      await asA.update(
        jsonRequest("PATCH", { country: "AU", timeZone: "Australia/Perth" }),
        ctx(created.id),
      ),
    );
    expect(client.timeZone).toBe("Australia/Perth");
  });

  it("rejects invalid fields", async () => {
    const created = await createAsA(VALID);
    const response = await asA.update(jsonRequest("PATCH", { email: "x" }), ctx(created.id));
    expect(response.status).toBe(400);
  });

  it("can't change another user's client", async () => {
    const response = await asA.update(
      jsonRequest("PATCH", { name: "Hijacked" }),
      ctx(USER_B.rows.clients),
    );
    expect(response.status).toBe(404);
    const { client } = await bodyOf<ClientBody>(
      await asB.get(new Request("http://x"), ctx(USER_B.rows.clients)),
    );
    expect(client.name).toBe("Client b");
  });
});

describe("DELETE /api/clients/[id]", () => {
  it("deletes the client", async () => {
    const created = await createAsA(VALID);
    expect((await asA.remove(new Request("http://x"), ctx(created.id))).status).toBe(204);
    expect((await asA.get(new Request("http://x"), ctx(created.id))).status).toBe(404);
  });

  it("can't delete another user's client", async () => {
    expect((await asA.remove(new Request("http://x"), ctx(USER_B.rows.clients))).status).toBe(404);
    expect((await asB.get(new Request("http://x"), ctx(USER_B.rows.clients))).status).toBe(200);
  });
});
