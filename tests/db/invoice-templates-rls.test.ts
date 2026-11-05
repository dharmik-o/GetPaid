import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USER_A, USER_B, seedOwnerSql } from "./fixtures";
import { inRollback, openMigratedPglite, type TestDatabase } from "./pglite";

// invoice_templates: the built-ins are shared and read-only; custom templates are their
// owner's only. (The generic one-row-per-owner suite can't cover a table with shared rows.)

let handle: TestDatabase;
const CLASSIC = "00000000-0000-4000-8000-00000000c001";
const B_TEMPLATE = "bbbbbbbb-0000-4000-8000-0000000000f1";

const as = <T>(userId: string | null, work: () => Promise<T>, role = "authenticated") =>
  inRollback(handle.db, async () => {
    await handle.db.query(`SET LOCAL ROLE ${role}`);
    if (userId) {
      await handle.db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role }),
      ]);
    }
    return work();
  });

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `INSERT INTO public.invoice_templates (id, user_id, name, kind, html)
     VALUES ('${B_TEMPLATE}', '${USER_B.userId}', 'B''s own', 'custom', '<p>{{greeting}}</p>')`,
  );
}, 60_000);

afterAll(async () => {
  await handle.close();
});

const names = async (userId: string | null) =>
  (
    await as(userId, () =>
      handle.db.query<{ name: string }>("SELECT name FROM public.invoice_templates ORDER BY name"),
    )
  ).rows.map((row) => row.name);

describe("invoice_templates RLS", () => {
  it("a user sees the built-ins and their own templates, not another user's", async () => {
    expect(await names(USER_A.userId)).toEqual(["Classic", "Ledger", "Minimal", "Modern", "Noir", "Studio"]);
    expect(await names(USER_B.userId)).toEqual([
      "B's own",
      "Classic",
      "Ledger",
      "Minimal",
      "Modern",
      "Noir",
      "Studio",
    ]);
  });

  it("a session with no user sees nothing, and anon has no access", async () => {
    expect(await names(null)).toEqual([]);
    await expect(
      as(null, () => handle.db.query("SELECT 1 FROM public.invoice_templates"), "anon"),
    ).rejects.toThrow(/permission denied/);
  });

  it("nobody can change or delete a built-in", async () => {
    const update = await as(USER_A.userId, () =>
      handle.db.query("UPDATE public.invoice_templates SET html = '<p>x</p>' WHERE id = $1", [
        CLASSIC,
      ]),
    );
    const remove = await as(USER_A.userId, () =>
      handle.db.query("DELETE FROM public.invoice_templates WHERE id = $1", [CLASSIC]),
    );
    expect([update.rowCount, remove.rowCount]).toEqual([0, 0]);
  });

  it("nobody can add a built-in, or a template owned by someone else", async () => {
    await expect(
      as(USER_A.userId, () =>
        handle.db.query(
          "INSERT INTO public.invoice_templates (user_id, name, kind, html) VALUES (NULL, 'Fake', 'builtin', '<p></p>')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(USER_A.userId, () =>
        handle.db.query(
          "INSERT INTO public.invoice_templates (user_id, name, kind, html) VALUES ($1, 'Mine?', 'custom', '<p></p>')",
          [USER_B.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a user can't change or delete another user's template", async () => {
    const update = await as(USER_A.userId, () =>
      handle.db.query("UPDATE public.invoice_templates SET name = 'Taken' WHERE id = $1", [
        B_TEMPLATE,
      ]),
    );
    const remove = await as(USER_A.userId, () =>
      handle.db.query("DELETE FROM public.invoice_templates WHERE id = $1", [B_TEMPLATE]),
    );
    expect([update.rowCount, remove.rowCount]).toEqual([0, 0]);
  });

  it("refuses a template over 100 KB", async () => {
    await expect(
      as(USER_A.userId, () =>
        handle.db.query(
          "INSERT INTO public.invoice_templates (user_id, name, kind, html) VALUES ($1, 'Big', 'custom', repeat('x', 102401))",
          [USER_A.userId],
        ),
      ),
    ).rejects.toThrow(/invoice_templates_size/);
  });

  it("refuses a logo that isn't an embedded image", async () => {
    await expect(
      as(USER_A.userId, () =>
        handle.db.query(
          "UPDATE public.users SET logo_data_url = 'https://x.example/logo.png' WHERE id = $1",
          [USER_A.userId],
        ),
      ),
    ).rejects.toThrow(/logo_data_url/);
  });
});
