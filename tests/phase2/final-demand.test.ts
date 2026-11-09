import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import {
  demandFacts,
  demandProblems,
  demandTemplate,
  draftFinalDemand,
  type DemandContext,
  type DemandFacts,
} from "@/lib/final-demand";
import { finalDemandHandlers } from "@/lib/final-demand-handlers";
import { demandPdfFile } from "@/lib/final-demand-letter";
import { saveGmailConnection } from "@/lib/gmail-account";
import { parseStatuteTable, type Law } from "@/lib/legal";
import { approveDraft, editDraft } from "@/lib/outbox-actions";
import { PROMPT_TEXT } from "@/lib/prompt-text";
import { parseReferenceRates } from "@/lib/reference-rates";
import { runSender, type SenderDeps } from "@/lib/sender";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { NO_ARCHIVE } from "../mocks/archive";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";

// C-S5: a final demand can't be sent without approval, and `demandProblems` rejects an extra link,
// an amount or date that isn't in the facts, a law that isn't the picked one, and a changed
// statement. Also the C4 "done when": for an overdue invoice with a UK business client (rates and
// the law approved in this test's fixtures, never in the real files) the draft shows the correct
// interest and compensation, the approved citation and the deadline, and goes out only after
// approval. Real migrations and RLS (PGlite); Gmail and the model are msw mocks.

let handle: TestDatabase;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const A = USER_A.userId;
const INVOICE = USER_A.rows.invoices;
const REMINDER = USER_A.rows.reminders;
const PROJECT = USER_A.rows.projects;
const CLIENT = USER_A.rows.clients;
const MODEL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-DEMAND-TEST-0001";
const CLIENT_EMAIL = "client-a@example.test";
/** A Wednesday, 10:00 in New York. The invoice below is due 8 Dec 2026: 15 days overdue. */
const NOW = new Date("2026-12-23T15:00:00Z");
const archiveDir = mkdtempSync(join(tmpdir(), "demand-archive-"));
const LETTER_PDF = Buffer.from("%PDF-1.7 fake demand letter");
const rendered: string[] = [];

const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, A, work);
const asUserId =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>) =>
    runAsUser(handle.db, userId, work);

const entry = (from: string, bp: number, approved = true) => ({
  from,
  bp,
  approved,
  source: "https://example.test/rate",
  checkedOn: "2026-11-09",
});
// Base rate 4.00% in force on 30 June 2026 (the reference date for a debt due in December 2026).
const RATES = parseReferenceRates({
  BOE_BASE: [entry("2025-01-01", 525), entry("2026-05-01", 400)],
  ECB_MRO: [],
  RBI_BANK: [entry("2025-01-01", 650)],
});

const law = (id: string, name: string, country: string, extra: Record<string, unknown>): Law => {
  const [parsed] = parseStatuteTable({
    laws: [
      {
        id,
        name,
        countries: [country],
        citation: `Under the ${name}, interest and a fixed sum may be claimed on late payments.`,
        sourceUrl: "https://example.test/law",
        checkedOn: "2026-11-09",
        approved: true,
        ...extra,
      },
    ],
  });
  if (!parsed) throw new Error("law did not parse");
  return parsed;
};
const UK = law("test-uk", "Test Late Payment Act", "GB", {
  appliesWhen: { clientIsBusiness: true },
  interest: {
    method: "simple_daily_over_reference",
    basis: "BOE_BASE",
    marginBp: 800,
    referenceDate: "half_year_start",
  },
  compensation: [
    { upToCents: 99_999, amountCents: 4_000, currency: "GBP" },
    { upToCents: 999_999, amountCents: 7_000, currency: "GBP" },
    { upToCents: null, amountCents: 10_000, currency: "GBP" },
  ],
});
const MSMED = law("in-msmed-2006", "Test MSMED Act", "IN", {
  appliesWhen: { freelancerHasUdyam: true },
  interest: {
    method: "monthly_compound_multiple",
    basis: "RBI_BANK",
    multiple: 3,
    paymentDays: { withAgreement: 45, withoutAgreement: 15 },
  },
});
const OTHER = law("test-other", "Other Fictional Act", "FR", {});

let laws: Law[] = [UK, OTHER];
const context = (): DemandContext => ({ now: NOW, laws, rates: RATES });
const deps = () => ({ runAsUser: asA, box: () => box, context });

const setInvoice = (sql: string) =>
  handle.db.query(`UPDATE public.invoices SET ${sql} WHERE id = '${INVOICE}'`);

/** GBP 2,000.00 due 8 Dec 2026 for a UK business client; nothing else waiting on the invoice. */
const reset = async () => {
  laws = [UK, OTHER];
  await handle.db.query(
    "UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL, sent_at = NULL, send_attempted_at = NULL WHERE invoice_id = $1",
    [INVOICE],
  );
  await handle.db.query("DELETE FROM public.reminders WHERE tier = 'final_demand'");
  await handle.db.query("DELETE FROM public.messages WHERE gmail_message_id IS NOT NULL");
  await setInvoice(
    `status = 'sent', link = '${PAY_LINK}', amount_cents = 200000, amount_paid_cents = 0, currency = 'GBP', due_date = '2026-12-08', reminders_held_at = NULL`,
  );
  await handle.db.query(
    "UPDATE public.clients SET country = 'GB', region = NULL, is_business = true, email = $2 WHERE id = $1",
    [CLIENT, CLIENT_EMAIL],
  );
  await handle.db.query(
    "UPDATE public.users SET udyam_number = NULL, address = '1 High Street, London', business_name = 'Alex Studio' WHERE id = $1",
    [A],
  );
  await handle.db.query("UPDATE public.projects SET late_fee_clause = NULL WHERE id = $1", [
    PROJECT,
  ]);
  await handle.db
    .query("DELETE FROM public.agreements WHERE project_id = $1", [PROJECT])
    .catch(() => undefined);
  rendered.length = 0;
};

const model = (reply: unknown): void => {
  server.use(
    http.post(MODEL_URL, () =>
      HttpResponse.json({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
    ),
  );
};

const facts = async (days?: number): Promise<DemandFacts> => {
  const result = await asA((db) => demandFacts(db, INVOICE, context(), days));
  if (!result.ok) throw new Error(`no facts: ${JSON.stringify(result)}`);
  return result.facts;
};

const senderDeps = (): SenderDeps => ({
  runAsService: (work) => runAsService(handle.db, work),
  runAsUser: asUserId,
  now: () => NOW,
  box: () => box,
  oauth: () => ({ clientId: "fake-client-id", clientSecret: "fake-client-secret" }),
  allowlist: () => new Set([CLIENT_EMAIL]),
  pdf: () => Promise.resolve(undefined),
  demandPdf: (userId, invoiceId, draft) =>
    demandPdfFile(
      {
        runAsUser: asUserId(userId),
        renderPdf: (html) => {
          rendered.push(html);
          return Promise.resolve(LETTER_PDF);
        },
        archiveDir,
        now: () => NOW,
      },
      invoiceId,
      draft,
    ),
  archive: NO_ARCHIVE,
});

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await asA((db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: null,
        taskModels: {},
      },
      box,
    ),
  );
  await asA((db) =>
    saveGmailConnection(db, {
      userId: A,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  gmail = createFakeGmail();
  server.use(...gmail.handlers);
  // By default the model is unreachable-as-useless: it answers something that fails the schema.
  model({ nonsense: true });
  await reset();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("the facts", () => {
  // GBP 2,000.00 due 8 Dec 2026, claimed 23 Dec 2026: 15 days. Due in the second half of the year, so the
  // base rate on 30 Jun 2026 applies: 4.00% + 8.00% = 12.00% (1,200 bp).
  //   200,000 × 1,200 × 15 ÷ (10,000 × 365) = 3,600,000,000 ÷ 3,650,000 = 986.3 → 986 cents (GBP 9.86).
  // A debt of GBP 2,000.00 is in the GBP 70.00 band. Total: 200,000 + 986 + 7,000 = 207,986 (GBP 2,079.86).
  it("holds the invoice, the deadline, the approved citation and the calculated amounts", async () => {
    const f = await facts();
    expect(f).toMatchObject({
      freelancerName: "Freelancer a",
      clientName: "Client a",
      invoiceNumber: expect.stringMatching(/\S/) as string,
      dueDate: "8 Dec 2026",
      amountDue: "GBP 2,000.00",
      amountPaid: null,
      daysOverdue: 15,
      deadline: "30 Dec 2026",
      totalToPay: "GBP 2,079.86",
      payLink: PAY_LINK,
    });
    expect(f.statements.law).toBe(UK.citation);
    expect(f.statements.claim).toBe(
      "Statutory interest of GBP 9.86 (8.00% above the Bank of England base rate of 4.00% = 12.00% a year, simple, for 15 days on GBP 2,000.00) and fixed compensation of GBP 70.00 are also due under Test Late Payment Act, bringing the total to GBP 2,079.86.",
    );
    expect(f.statements.nextStep).toBe(
      "If payment isn't received by 30 Dec 2026, I will pursue recovery through the courts or a collection agency.",
    );
    expect(f.statements).toMatchObject({ agreement: null, udyam: null });
  });

  it("subtracts what was paid, and takes a deadline of 7 to 14 days", async () => {
    await setInvoice("amount_paid_cents = 50000, status = 'partially_paid'");
    const f = await facts(14);
    expect(f).toMatchObject({
      amountDue: "GBP 1,500.00",
      amountPaid: "GBP 500.00",
      deadline: "6 Jan 2027",
    });
  });

  it("cites nothing and calculates nothing when no approved law applies", async () => {
    for (const none of [
      [],
      [OTHER],
      [law("test-uk-draft", "Draft Act", "GB", { approved: false })],
    ]) {
      laws = none;
      const f = await facts();
      expect(f.statements).toMatchObject({ law: null, claim: null, agreement: null });
      expect(f.totalToPay).toBe(f.amountDue);
    }
  });

  it("doesn't apply a business-only law to a private client", async () => {
    await handle.db.query("UPDATE public.clients SET is_business = false WHERE id = $1", [CLIENT]);
    expect((await facts()).statements.law).toBeNull();
  });

  it("quotes the project's own late-payment clause, and a signed agreement's instead of it", async () => {
    await handle.db.query(
      "UPDATE public.projects SET late_fee_clause = '1.5% a month on late invoices.' WHERE id = $1",
      [PROJECT],
    );
    expect((await facts()).statements.agreement).toBe(
      `Our contract's late-payment clause says: "1.5% a month on late invoices."`,
    );
    await handle.db.query(
      `INSERT INTO public.agreements (user_id, project_id, client_id, number, status, options, facts, body_html, body_sha256,
         signer_name, signer_ip, signed_at)
       VALUES ($1, $2, $3, 'AGR-000777', 'signed', '{}', '{"lateFeeClauseText": "A fixed fee of GBP 50.00 applies to late invoices."}', '<p>x</p>', $4, 'Sam', '203.0.113.9', now())`,
      [A, PROJECT, CLIENT, "0".repeat(64)],
    );
    expect((await facts()).statements.agreement).toBe(
      `Under our signed agreement AGR-000777, the late-payment clause says: "A fixed fee of GBP 50.00 applies to late invoices."`,
    );
  });

  it("India with a Udyam number: the MSMED law and the MSME Facilitation Council as the next step", async () => {
    laws = [MSMED];
    await handle.db.query("UPDATE public.clients SET country = 'IN' WHERE id = $1", [CLIENT]);
    await handle.db.query(
      "UPDATE public.users SET udyam_number = 'UDYAM-MH-12-1234567' WHERE id = $1",
      [A],
    );
    await setInvoice("currency = 'INR'");
    const f = await facts();
    expect(f.statements.nextStep).toContain("refer the matter to the MSME Facilitation Council");
    expect(f.statements.udyam).toBe("My Udyam registration number is UDYAM-MH-12-1234567.");
    expect(f.statements.claim).toContain("Test MSMED Act");
    // Without the number the law doesn't apply, and the next step is the general one.
    await handle.db.query("UPDATE public.users SET udyam_number = NULL WHERE id = $1", [A]);
    const without = await facts();
    expect(without.statements).toMatchObject({ law: null, claim: null, udyam: null });
    expect(without.statements.nextStep).toContain("courts or a collection agency");
  });

  it.each([
    ["not overdue", "due_date = '2026-12-30'", "isn't overdue"],
    ["paid", "status = 'paid'", "nothing to demand"],
    ["cancelled", "status = 'cancelled'", "nothing to demand"],
    ["disputed", "status = 'disputed'", "nothing to demand"],
    ["fully paid", "amount_paid_cents = 200000", "nothing owing"],
    ["without a pay link", "link = NULL", "no pay link"],
    ["on hold for a client reply", "reminders_held_at = now()", "waiting for your decision"],
  ])("refuses an invoice that is %s", async (_label, change, words) => {
    await setInvoice(change);
    const result = await asA((db) => demandFacts(db, INVOICE, context()));
    expect(result).toMatchObject({ ok: false, conflict: expect.stringContaining(words) as string });
  });

  it("doesn't find another user's invoice", async () => {
    const result = await runAsUser(handle.db, USER_B.userId, (db) =>
      demandFacts(db, INVOICE, context()),
    );
    expect(result).toEqual({ ok: false, notFound: true });
  });
});

describe("demandProblems (C-S5)", () => {
  const good = async () => demandTemplate(await facts());
  const withBody = async (change: (body: string, f: DemandFacts) => string) => {
    const f = await facts();
    const draft = demandTemplate(f);
    return { f, draft: { ...draft, body: change(draft.body, f) } };
  };

  it("passes the fixed template", async () => {
    expect(demandProblems(await good(), await facts(), laws)).toEqual([]);
  });

  it("rejects an extra link, or a missing pay link", async () => {
    const extra = await withBody((body) => `${body}\n\nSee https://evil.test/pay`);
    expect(demandProblems(extra.draft, extra.f, laws)).toContain(
      "it has a link other than the pay link",
    );
    const missing = await withBody((body, f) => body.replace(f.payLink, ""));
    expect(demandProblems(missing.draft, missing.f, laws)).toContain(
      "the body doesn't include the pay link",
    );
  });

  it("rejects an amount that isn't in the facts, or one in the wrong currency", async () => {
    const wrong = await withBody((body) => `${body}\n\nI also ask for GBP 5,000.00.`);
    expect(demandProblems(wrong.draft, wrong.f, laws)).toContain(
      "it mentions an amount that isn't in the facts",
    );
    const currency = await withBody((body, f) => body.replace(f.amountDue, "USD 2,000.00"));
    expect(demandProblems(currency.draft, currency.f, laws).join(" ")).toContain("wrong currency");
  });

  it("rejects a date that isn't in the facts", async () => {
    const dated = await withBody((body) => `${body}\n\nI will call you on 3 Jan 2027.`);
    expect(demandProblems(dated.draft, dated.f, laws).join(" ")).toContain(
      "a date that isn't in the facts",
    );
    const noDeadline = await withBody((body, f) => body.replaceAll(f.deadline, "soon"));
    expect(demandProblems(noDeadline.draft, noDeadline.f, laws)).toContain(
      "it doesn't give the payment deadline",
    );
  });

  it("rejects a changed, shortened or missing citation, claim or next step", async () => {
    const f = await facts();
    for (const statement of [f.statements.law, f.statements.claim, f.statements.nextStep]) {
      const changed = demandTemplate(f);
      const text = `${(statement ?? "").slice(0, -1)}!`;
      expect(
        demandProblems({ ...changed, body: changed.body.replace(statement ?? "", text) }, f, laws),
      ).toContain("it leaves out or changes a required statement");
      expect(
        demandProblems({ ...changed, body: changed.body.replace(statement ?? "", "") }, f, laws),
      ).toContain("it leaves out or changes a required statement");
    }
  });

  it("rejects a law that isn't the picked one, and legal or fee words of its own", async () => {
    for (const addition of [
      "Under the Other Fictional Act you owe more.",
      "I will sue you.",
      "A late fee also applies.",
      "I have instructed my lawyer.",
      "Interest keeps running.",
      "This is a statutory demand.",
    ]) {
      const { f, draft } = await withBody((body) =>
        body.replace("Regards,", `${addition}\n\nRegards,`),
      );
      expect(demandProblems(draft, f, laws), addition).toContain(
        "it makes a legal or fee reference that isn't one of the given statements",
      );
    }
  });

  it("lets the given statements carry every legal word, and plain words stay fine", async () => {
    const f = await facts();
    const draft = demandTemplate(f);
    expect(draft.body).toContain("Statutory interest");
    expect(draft.body).toContain("courts");
    expect(
      demandProblems(
        { subject: draft.subject, body: `${draft.body}\n\nThank you for your attention.` },
        f,
        laws,
      ),
    ).toEqual([]);
  });

  it("rejects a subject with a line break", async () => {
    const f = await facts();
    expect(
      demandProblems({ ...demandTemplate(f), subject: "Final demand\nBcc: x" }, f, laws),
    ).toContain("the subject has a line break");
  });
});

describe("drafting the letter", () => {
  it("uses the fixed template when no model gives a valid letter, and leaves it waiting in the Outbox", async () => {
    const result = await draftFinalDemand(deps(), INVOICE, { deadlineDays: 7 });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.draft).toMatchObject({
      kind: "final_demand",
      via: "template",
      citation: "statute",
      lawId: "test-uk",
      notLegalAdvice: true,
    });
    expect(result.draft.body).toContain("GBP 2,079.86");
    expect(result.draft.body).toContain("30 Dec 2026");
    expect(result.draft.body).toContain(UK.citation);
    const row = await handle.db.query<{
      tier: string;
      approval_status: string;
      sent_at: unknown;
      draft: unknown;
    }>("SELECT tier, approval_status, sent_at, draft FROM public.reminders WHERE id = $1", [
      result.reminderId,
    ]);
    expect(row.rows[0]).toMatchObject({
      tier: "final_demand",
      approval_status: "waiting",
      sent_at: null,
    });
    expect(storedDraftSchema.safeParse(row.rows[0]?.draft).success).toBe(true);
  });

  it("uses the model's letter when it passes every check, and the template when it doesn't", async () => {
    const f = await facts();
    const letter = demandTemplate(f);
    model({ subject: letter.subject, body: letter.body.replace("Dear", "Hello") });
    const good = await draftFinalDemand(deps(), INVOICE, {});
    if (!good.ok) throw new Error(JSON.stringify(good));
    expect(good.draft).toMatchObject({ via: "model", model: "llama3.2" });
    await handle.db.query("DELETE FROM public.reminders WHERE id = $1", [good.reminderId]);
    model({ subject: letter.subject, body: `${letter.body}\n\nhttps://evil.test/pay` });
    const bad = await draftFinalDemand(deps(), INVOICE, {});
    if (!bad.ok) throw new Error(JSON.stringify(bad));
    expect(bad.draft.via).toBe("template");
    expect(bad.draft.body).not.toContain("evil.test");
  });

  it("refuses a second demand while one waits, and while another reminder waits on the invoice", async () => {
    const first = await draftFinalDemand(deps(), INVOICE, {});
    expect(first.ok).toBe(true);
    expect(await draftFinalDemand(deps(), INVOICE, {})).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("already has a reminder waiting") as string,
    });
    await handle.db.query("DELETE FROM public.reminders WHERE tier = 'final_demand'");
    await handle.db.query("UPDATE public.reminders SET approval_status = 'waiting' WHERE id = $1", [
      REMINDER,
    ]);
    expect(await draftFinalDemand(deps(), INVOICE, {})).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("already has a reminder waiting") as string,
    });
  });

  it("checks the deadline: 7 to 14 days", async () => {
    for (const deadlineDays of [6, 15, 7.5, "7"]) {
      expect(await draftFinalDemand(deps(), INVOICE, { deadlineDays })).toMatchObject({
        ok: false,
        errors: [{ field: "deadlineDays" }],
      });
    }
    expect(await draftFinalDemand(deps(), INVOICE, { deadlineDays: 14 })).toMatchObject({
      ok: true,
    });
    expect(await draftFinalDemand(deps(), INVOICE, { extra: 1 })).toMatchObject({
      ok: false,
      errors: [{ field: "extra" }],
    });
  });

  it("can't be edited or reworded in the Outbox, and an approval is the only way out", async () => {
    const made = await draftFinalDemand(deps(), INVOICE, {});
    if (!made.ok) throw new Error("draft");
    expect(
      await asA((db) =>
        editDraft(
          db,
          made.reminderId,
          { subject: "Hi", body: `Pay ${PAY_LINK}` },
          { now: NOW, laws },
        ),
      ),
    ).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("can't be edited") as string,
    });
  });

  it("answers over HTTP: 201, 404 for another user's invoice, 409 when not overdue, 400 for a bad deadline", async () => {
    const handlers = (userId: string) =>
      finalDemandHandlers({ runAsUser: asUserId(userId), box: () => box, context });
    const call = (userId: string, id: string, body: unknown) =>
      handlers(userId).post(
        new Request("http://app.test/api/invoices/x/final-demand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    expect((await call(USER_B.userId, INVOICE, {})).status).toBe(404);
    expect((await call(A, "not-an-id", {})).status).toBe(404);
    expect((await call(A, INVOICE, { deadlineDays: 3 })).status).toBe(400);
    expect((await call(A, INVOICE, {})).status).toBe(201);
    await handle.db.query("DELETE FROM public.reminders WHERE tier = 'final_demand'");
    await setInvoice("due_date = '2026-12-30'");
    expect((await call(A, INVOICE, {})).status).toBe(409);
  });
});

describe("sending (always after approval)", () => {
  it("sends nothing before approval; after it, one email with the letter's PDF, which is kept in the archive", async () => {
    const made = await draftFinalDemand(deps(), INVOICE, {});
    if (!made.ok) throw new Error("draft");
    expect(await runSender(senderDeps())).toEqual({ sent: 0, held: 0 });
    expect(gmail.state.sent).toHaveLength(0);
    expect(await asA((db) => approveDraft(db, made.reminderId))).toEqual({ status: "ok" });
    expect(await runSender(senderDeps())).toMatchObject({ sent: 1 });
    const mail = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(mail).toContain("application/pdf");
    expect(mail).toContain(LETTER_PDF.toString("base64"));
    expect(mail).toContain("demand-");
    expect(mail.replace(/\r\n/g, "")).toContain(
      Buffer.from(made.draft.body, "utf8").toString("base64"),
    );
    expect(rendered[0]).toContain("Final demand for payment");
    expect(rendered[0]).toContain("Alex Studio");
    expect(rendered[0]).toContain("1 High Street, London");
    const invoiceNumber = (
      await handle.db.query<{ invoice_number: string }>(
        "SELECT invoice_number FROM public.invoices WHERE id = $1",
        [INVOICE],
      )
    ).rows[0]?.invoice_number;
    expect(
      existsSync(
        join(
          archiveDir,
          "Client a",
          "Website redesign",
          "Demands",
          `${invoiceNumber ?? "?"}-demand-2026-12-23.pdf`,
        ),
      ),
    ).toBe(true);
  });

  it("is held, not sent without its letter, when the PDF can't be made", async () => {
    const made = await draftFinalDemand(deps(), INVOICE, {});
    if (!made.ok) throw new Error("draft");
    await asA((db) => approveDraft(db, made.reminderId));
    const failing: SenderDeps = {
      ...senderDeps(),
      demandPdf: () => Promise.reject(new Error("no chromium")),
    };
    expect(await runSender(failing)).toMatchObject({ sent: 0, held: 1 });
    expect(gmail.state.sent).toHaveLength(0);
  });

  it("is stopped, not sent, when the invoice is paid before it goes", async () => {
    const made = await draftFinalDemand(deps(), INVOICE, {});
    if (!made.ok) throw new Error("draft");
    await asA((db) => approveDraft(db, made.reminderId));
    await setInvoice("status = 'paid', amount_paid_cents = 200000");
    expect(await runSender(senderDeps())).toEqual({ sent: 0, held: 0 });
    expect(gmail.state.sent).toHaveLength(0);
  });
});

describe("the prompt", () => {
  it("asks for JSON with a subject and body, from the facts only, with the statements word for word", () => {
    const text = PROMPT_TEXT.final_demand;
    expect(text).toContain("<facts>");
    expect(text).toMatch(/Use only those facts\. Never invent amounts, dates, fees/);
    expect(text).toMatch(/word for word/);
    expect(text).toMatch(/never present the letter as coming from a collection agency/);
    expect(text).toContain("`subject`");
    expect(text).toContain("`body`");
    expect(text).toMatch(/only a JSON object/);
  });
});
