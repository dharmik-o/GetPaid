import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDraft,
  getAgreement,
  listAgreements,
  newVersion,
  previewAgreement,
  updateDraft,
  voidAgreement,
  type Context,
} from "@/lib/agreements";
import { runAsUser, type Db } from "@/lib/db";
import { parseStatuteTable } from "@/lib/legal";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// C-S1: another user's agreement can't be read, changed or voided. C-S2: once an agreement is
// sent, the database refuses any change to its document. Also the C2 "done when": a draft for a
// project shows the right amounts, milestones and options, and can be saved and voided. Real
// migrations and RLS (PGlite).

let handle: TestDatabase;
const A = USER_A.userId;
const B = USER_B.userId;
const ctx: Context = { now: new Date("2026-11-09T12:00:00Z"), laws: [] };
const OPTIONS = { governingLawCountry: "US" };

const as = <T>(userId: string, work: (db: Db) => Promise<T>) => runAsUser(handle.db, userId, work);
const asA = <T>(work: (db: Db) => Promise<T>) => as(A, work);
const asB = <T>(work: (db: Db) => Promise<T>) => as(B, work);

const saved = async <T extends { ok: boolean }>(result: Promise<T>) => {
  const outcome = await result;
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome)}`);
  return outcome as Extract<T, { ok: true }>;
};

const statusOf = async (id: string): Promise<string | undefined> =>
  (
    await handle.db.query<{ status: string }>(
      "SELECT status FROM public.agreements WHERE id = $1",
      [id],
    )
  ).rows[0]?.status;

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe("agreements are private to their owner (C-S1)", () => {
  it("hides another user's agreements from reads and lists", async () => {
    expect(await asA((db) => getAgreement(db, USER_B.rows.agreements))).toBeUndefined();
    expect(await asA((db) => listAgreements(db, USER_B.rows.projects))).toEqual([]);
  });

  it("can't void, edit or replace another user's agreement, and nothing changes", async () => {
    const draft = (await saved(asB((db) => createDraft(db, USER_B.rows.projects, OPTIONS, ctx))))
      .agreement;
    expect(await asA((db) => voidAgreement(db, draft.id))).toEqual({ ok: false, notFound: true });
    expect(await asA((db) => updateDraft(db, draft.id, OPTIONS, ctx))).toEqual({
      ok: false,
      notFound: true,
    });
    expect(await asA((db) => newVersion(db, draft.id, ctx))).toEqual({ ok: false, notFound: true });
    expect(await statusOf(draft.id)).toBe("draft");
    // Marking it sent by hand (what sending will do) is refused by row-level security too.
    const { rowCount } = await asA((db) =>
      db.query("UPDATE public.agreements SET status = 'sent' WHERE id = $1", [draft.id]),
    );
    expect(rowCount).toBe(0);
    await asB((db) => voidAgreement(db, draft.id));
  });

  it("can't draft an agreement on another user's project", async () => {
    expect(await asA((db) => createDraft(db, USER_B.rows.projects, OPTIONS, ctx))).toEqual({
      ok: false,
      notFound: true,
    });
    expect(await asA((db) => previewAgreement(db, USER_B.rows.projects, OPTIONS, ctx))).toEqual({
      ok: false,
      notFound: true,
    });
  });

  it("can't be deleted by its owner: agreements are voided, not deleted", async () => {
    await expect(
      asA((db) =>
        db.query("DELETE FROM public.agreements WHERE id = $1", [USER_A.rows.agreements]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("a sent agreement's document is frozen (C-S2)", () => {
  it("refuses a change to the document, its options or its facts once sent", async () => {
    const { agreement } = await saved(
      asA((db) => createDraft(db, USER_A.rows.projects, OPTIONS, ctx)),
    );
    await asA((db) =>
      db.query("UPDATE public.agreements SET status = 'sent' WHERE id = $1", [agreement.id]),
    );
    for (const change of [
      "body_html = '<p>Changed</p>'",
      `body_sha256 = '${"1".repeat(64)}'`,
      "options = '{}'",
      "facts = '{}'",
    ]) {
      await expect(
        asA((db) =>
          db.query(`UPDATE public.agreements SET ${change} WHERE id = $1`, [agreement.id]),
        ),
      ).rejects.toThrow(/can no longer change/);
    }
    // The code refuses first, with a plain message.
    expect(await asA((db) => updateDraft(db, agreement.id, OPTIONS, ctx))).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("Make a new version") as string,
    });
    // A status change is still allowed, so it can be voided.
    expect((await saved(asA((db) => voidAgreement(db, agreement.id)))).agreement.status).toBe(
      "void",
    );
  });
});

describe("the agreement builder (C2 done when)", () => {
  it("shows the right amounts, milestones, ongoing services and options in the draft", async () => {
    const { agreement } = await saved(
      asA((db) =>
        createDraft(
          db,
          USER_A.rows.projects,
          { ...OPTIONS, depositPercent: 30, revisionRounds: 3 },
          ctx,
        ),
      ),
    );
    expect(agreement).toMatchObject({ version: 1, status: "draft" });
    expect(agreement.number).toMatch(/^AGR-\d{6}$/);
    const html = agreement.bodyHtml.replaceAll(String.fromCharCode(160), " ");
    expect(html).toContain("USD 3,000.00");
    expect(html).toContain("deposit of 30% (USD 900.00)");
    expect(html).toContain("balance of USD 2,100.00");
    expect(html).toContain("Design");
    expect(html).toContain("USD 900.00");
    expect(html).toContain("Retainer &quot;Monthly maintenance&quot;: USD 200.00 every month.");
    expect(html).toContain("Security updates and backups, every 6 months");
    expect(html).toContain("3 rounds of revisions");
    expect(html).toContain("Freelancer a");
    expect(html).toContain("the law of United States of America");
    expect(html).toContain("Content-Security-Policy");
    expect(agreement.facts.effectiveDate).toBe("2026-11-09");
    await asA((db) => voidAgreement(db, agreement.id));
  });

  it("escapes everything it fills in", async () => {
    await handle.db.query("UPDATE public.projects SET title = $2 WHERE id = $1", [
      USER_A.rows.projects,
      '<img src=x onerror="alert(1)">',
    ]);
    const preview = await saved(
      asA((db) => previewAgreement(db, USER_A.rows.projects, OPTIONS, ctx)),
    );
    expect(preview.html).not.toContain("<img");
    expect(preview.html).toContain("&lt;img src&#x3D;x onerror&#x3D;&quot;alert(1)&quot;&gt;");
    await handle.db.query("UPDATE public.projects SET title = 'Website redesign' WHERE id = $1", [
      USER_A.rows.projects,
    ]);
  });

  it("saves changes to a draft with a fresh hash, refuses a second agreement in progress, and voids", async () => {
    const first = (await saved(asA((db) => createDraft(db, USER_A.rows.projects, OPTIONS, ctx))))
      .agreement;
    expect(await asA((db) => createDraft(db, USER_A.rows.projects, OPTIONS, ctx))).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("already has an agreement in progress") as string,
    });
    const changed = (
      await saved(asA((db) => updateDraft(db, first.id, { ...OPTIONS, depositPercent: 0 }, ctx)))
    ).agreement;
    expect(changed.bodySha256).not.toBe(first.bodySha256);
    expect(changed.bodyHtml).not.toContain("A deposit of");
    expect((await saved(asA((db) => voidAgreement(db, first.id)))).agreement.status).toBe("void");
    expect(await asA((db) => voidAgreement(db, first.id))).toMatchObject({
      ok: false,
      conflict: expect.any(String) as string,
    });
    // With nothing in progress, a new draft is allowed again.
    const again = (await saved(asA((db) => createDraft(db, USER_A.rows.projects, OPTIONS, ctx))))
      .agreement;
    await asA((db) => voidAgreement(db, again.id));
  });

  it("makes a new version from a sent agreement: same number, old one voided; never from a signed one", async () => {
    const first = (await saved(asA((db) => createDraft(db, USER_A.rows.projects, OPTIONS, ctx))))
      .agreement;
    expect(await asA((db) => newVersion(db, first.id, ctx))).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("still a draft") as string,
    });
    await asA((db) =>
      db.query("UPDATE public.agreements SET status = 'sent' WHERE id = $1", [first.id]),
    );
    const second = (await saved(asA((db) => newVersion(db, first.id, ctx)))).agreement;
    expect(second).toMatchObject({
      number: first.number,
      version: first.version + 1,
      status: "draft",
    });
    expect(await statusOf(first.id)).toBe("void");
    await handle.db.query(
      "UPDATE public.agreements SET status = 'signed', signer_name = 'Sam', signer_ip = '203.0.113.9', signed_at = now() WHERE id = $1",
      [second.id],
    );
    expect(await asA((db) => newVersion(db, second.id, ctx))).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("signed") as string,
    });
    expect(await asA((db) => voidAgreement(db, second.id))).toMatchObject({ ok: false });
  });

  it("checks every option and names the field", async () => {
    const result = await asB((db) =>
      previewAgreement(
        db,
        USER_B.rows.projects,
        {
          ...OPTIONS,
          depositPercent: 101,
          lateFee: { mode: "contract_rate", rateBpPerMonth: 0, fixedFeeCents: 0 },
        },
        ctx,
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && "errors" in result) {
      expect(result.errors.map((e) => e.field)).toEqual(
        expect.arrayContaining(["depositPercent", "lateFee"]),
      );
    }
    expect(await asB((db) => previewAgreement(db, USER_B.rows.projects, {}, ctx))).toMatchObject({
      ok: false,
    });
  });

  it("limits payment days to 45 for a client in India when the freelancer has a Udyam number", async () => {
    await handle.db.query("UPDATE public.clients SET country = 'IN' WHERE id = $1", [
      USER_B.rows.clients,
    ]);
    await handle.db.query(
      "UPDATE public.users SET udyam_number = 'UDYAM-MH-12-1234567' WHERE id = $1",
      [B],
    );
    const preview = (days: number) =>
      asB((db) =>
        previewAgreement(
          db,
          USER_B.rows.projects,
          { governingLawCountry: "IN", paymentDays: days },
          ctx,
        ),
      );
    expect(await preview(60)).toMatchObject({ ok: false, errors: [{ field: "paymentDays" }] });
    const ok = await preview(45);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.html).toContain("Udyam registration UDYAM-MH-12-1234567");
  });

  it("cites an approved law in the late-payment section only when it applies, else says nothing specific", async () => {
    const law = (approved: boolean) =>
      parseStatuteTable({
        laws: [
          {
            id: "test-us",
            name: "Test Freelance Act",
            countries: ["US"],
            citation: "Under the Test Freelance Act, interest may apply to late payments.",
            sourceUrl: "https://example.test/law",
            checkedOn: "2026-11-09",
            approved,
          },
        ],
      });
    const html = async (approved: boolean) => {
      const result = await saved(
        asA((db) =>
          previewAgreement(db, USER_A.rows.projects, OPTIONS, { ...ctx, laws: law(approved) }),
        ),
      );
      return result.html;
    };
    expect(await html(true)).toContain(
      "Under the Test Freelance Act, interest may apply to late payments.",
    );
    const unapproved = await html(false);
    expect(unapproved).not.toContain("Test Freelance Act");
    expect(unapproved).toContain("as allowed by the law that applies");
  });
});
