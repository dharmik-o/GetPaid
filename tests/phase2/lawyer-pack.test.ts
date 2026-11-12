import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { buildLawyerPack, PAGE_LIMIT, type PackDeps } from "@/lib/lawyer-pack";
import { lawyerPackHandlers } from "@/lib/lawyer-pack-handlers";
import { parseStatuteTable, type Law } from "@/lib/legal";
import { parseReferenceRates } from "@/lib/reference-rates";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// C-S6: another user's project answers 404, and a path outside the archive is refused. Also the C5
// "done when": the pack is one PDF with the cover, the signed agreement, the invoices, the timeline and
// the demands, in that order, and nothing secret or from another user goes in. Real migrations and RLS
// (PGlite); Chromium is replaced by a renderer that makes real, tiny PDFs, so the merging is real.

let handle: TestDatabase;
const A = USER_A.userId;
const PROJECT = USER_A.rows.projects;
const INVOICE = USER_A.rows.invoices;
const NOW = new Date("2026-12-23T15:00:00Z");
const root = mkdtempSync(join(tmpdir(), "pack-root-"));
let archiveDir = join(root, "archive-0");
let runs = 0;
const OUTSIDE = join(root, "outside-secret.pdf");

const SIZES = {
  cover: 100,
  timeline: 200,
  invoice: 301,
  invoiceNew: 302,
  agreement: 303,
  demand: 304,
  outside: 399,
};

const makePdf = async (size: number, pages = 1): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([size, size]);
  return Buffer.from(await doc.save());
};

const put = (relative: string, bytes: Buffer): void => {
  const file = join(archiveDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};

const rendered: string[] = [];
const renderPdf = async (html: string): Promise<Buffer> => {
  rendered.push(html);
  return makePdf(html.includes("<h1>Lawyer pack</h1>") ? SIZES.cover : SIZES.timeline);
};

const entry = (from: string, bp: number) => ({
  from,
  bp,
  approved: true,
  source: "https://example.test/r",
  checkedOn: "2026-11-09",
});
const RATES = parseReferenceRates({
  BOE_BASE: [entry("2025-01-01", 525), entry("2026-05-01", 400)],
  ECB_MRO: [],
  RBI_BANK: [],
});
const [UK_LAW] = parseStatuteTable({
  laws: [
    {
      id: "test-uk",
      name: "Test Late Payment Act",
      countries: ["GB"],
      citation: "Under the Test Late Payment Act, interest may be claimed.",
      sourceUrl: "https://example.test/law",
      checkedOn: "2026-11-09",
      approved: true,
      appliesWhen: { clientIsBusiness: true },
      interest: {
        method: "simple_daily_over_reference",
        basis: "BOE_BASE",
        marginBp: 800,
        referenceDate: "half_year_start",
      },
      compensation: [{ upToCents: null, amountCents: 7_000, currency: "GBP" }],
    },
  ],
});
let laws: readonly Law[] = [];

const deps = (userId = A): PackDeps => ({
  runAsUser: <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, userId, work),
  renderPdf,
  archiveDir,
  now: () => NOW,
  laws,
  rates: RATES,
});

/** The width of every page, which says which source each page came from. */
const sizesOf = async (bytes: Buffer): Promise<number[]> =>
  (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getSize().width));

const build = async () => {
  const pack = await buildLawyerPack(deps(), PROJECT);
  if (!pack.ok) throw new Error("not found");
  return pack;
};

const cover = (): string =>
  rendered.filter((html) => html.includes("<h1>Lawyer pack</h1>")).at(-1) ?? "";
const timeline = (): string =>
  rendered.filter((html) => html.includes("<h1>Timeline</h1>")).at(-1) ?? "";

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  rendered.length = 0;
  laws = [];
  runs += 1;
  archiveDir = join(root, `archive-${String(runs)}`);
  mkdirSync(archiveDir, { recursive: true });
  await handle.db.query("DELETE FROM public.invoice_archive_files WHERE invoice_id = $1", [
    INVOICE,
  ]);
  await handle.db.query(
    "DELETE FROM public.agreements WHERE project_id = $1 AND status = 'signed'",
    [PROJECT],
  );
  await handle.db.query("DELETE FROM public.messages WHERE direction = 'in'");
  await handle.db.query(
    "UPDATE public.invoices SET status = 'sent', amount_paid_cents = 0, currency = 'USD', due_date = '2026-12-08' WHERE id = $1",
    [INVOICE],
  );
  await handle.db.query(
    "UPDATE public.clients SET country = 'US', is_business = true WHERE id = $1",
    [USER_A.rows.clients],
  );
  writeFileSync(OUTSIDE, await makePdf(SIZES.outside));
  const row = (version: number, path: string) =>
    handle.db.query(
      "INSERT INTO public.invoice_archive_files (user_id, invoice_id, version, relative_path, sha256) VALUES ($1, $2, $3, $4, $5)",
      [A, INVOICE, version, path, "0".repeat(64)],
    );
  put("Client a/Website redesign/FPR-1.pdf", await makePdf(SIZES.invoice));
  put("Client a/Website redesign/FPR-1 (v2).pdf", await makePdf(SIZES.invoiceNew));
  await row(1, "Client a/Website redesign/FPR-1.pdf");
  await row(2, "Client a/Website redesign/FPR-1 (v2).pdf");
  put("Client a/Website redesign/Agreements/AGR-000002-v1.pdf", await makePdf(SIZES.agreement, 2));
  await handle.db.query(
    `INSERT INTO public.agreements (user_id, project_id, client_id, number, status, options, facts, body_html, body_sha256,
       signer_name, signer_ip, signed_at, signed_pdf_path, token_sha256)
     VALUES ($1, $2, $3, 'AGR-000002', 'signed', '{}', '{}', '<p>x</p>', $4, 'Sam Lee', '203.0.113.9', $5,
       'Client a/Website redesign/Agreements/AGR-000002-v1.pdf', $6)`,
    [A, PROJECT, USER_A.rows.clients, "0".repeat(64), NOW.toISOString(), "f".repeat(64)],
  );
  put("Client a/Website redesign/Demands/FPR-1-demand-2026-12-20.pdf", await makePdf(SIZES.demand));
});

describe("access (C-S6)", () => {
  it("answers not found for another user's project, and for a malformed id", async () => {
    expect(await buildLawyerPack(deps(), USER_B.rows.projects)).toEqual({
      ok: false,
      notFound: true,
    });
    const handlers = lawyerPackHandlers(deps());
    const call = (id: string) =>
      handlers.post(new Request("http://app.test/x", { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
    expect((await call(USER_B.rows.projects)).status).toBe(404);
    expect((await call("nope")).status).toBe(404);
    expect(rendered).toHaveLength(0);
  });

  it("refuses a stored path outside the archive: it is never read, and the file's pages never appear", async () => {
    await handle.db.query(
      "UPDATE public.invoice_archive_files SET relative_path = '../outside-secret.pdf' WHERE invoice_id = $1 AND version = 2",
      [INVOICE],
    );
    await handle.db.query(
      "UPDATE public.agreements SET signed_pdf_path = '../outside-secret.pdf' WHERE project_id = $1 AND status = 'signed'",
      [PROJECT],
    );
    const pack = await build();
    const sizes = await sizesOf(pack.bytes);
    expect(sizes).not.toContain(SIZES.outside);
    expect(
      pack.notIncluded.filter((line) => line.includes("outside the archive folder")),
    ).toHaveLength(2);
    // An absolute path, a drive letter, a backslash and a name that isn't a PDF are refused the same way.
    for (const bad of [
      "/etc/passwd.pdf",
      "C:/secret.pdf",
      "Client a\\x.pdf",
      "../archive/../outside-secret.pdf",
      "Client a/notes.txt",
    ]) {
      await handle.db.query(
        "UPDATE public.invoice_archive_files SET relative_path = $2 WHERE invoice_id = $1 AND version = 2",
        [INVOICE, bad],
      );
      const again = await build();
      expect(await sizesOf(again.bytes)).not.toContain(SIZES.outside);
      expect(again.notIncluded.join(" ")).toContain("outside the archive folder");
    }
    expect(readFileSync(OUTSIDE).length).toBeGreaterThan(0);
  });
});

describe("the pack", () => {
  it("is one PDF: cover, signed agreement, newest invoice, timeline, then the demands", async () => {
    const pack = await build();
    expect(pack.pages).toBe(6);
    expect(await sizesOf(pack.bytes)).toEqual([
      SIZES.cover,
      SIZES.agreement,
      SIZES.agreement,
      SIZES.invoiceNew,
      SIZES.timeline,
      SIZES.demand,
    ]);
    const html = cover();
    for (const line of [
      "Signed agreement AGR-000002, version 1",
      "Invoice",
      "Timeline",
      "Final demand FPR-1-demand-2026-12-20.pdf",
    ]) {
      expect(html).toContain(line);
    }
    expect(html).toContain(
      "<tr><td>Signed agreement AGR-000002, version 1</td><td>2 to 3</td></tr>",
    );
    expect(html).toContain("<td>Timeline</td><td>5</td>");
    expect(html).toContain("<td>Cover and contents</td><td>1</td>");
    expect(html).toContain("an earlier version, FPR-1.pdf");
    expect(html).toContain("not legal advice");
  });

  it("is kept in the archive folder and returned, and a second pack never replaces the first", async () => {
    const first = await build();
    expect(first.relativePath).toBe("Client a/Website redesign/Lawyer-pack-2026-12-23.pdf");
    expect(readFileSync(join(archiveDir, first.relativePath))).toEqual(first.bytes);
    const second = await build();
    expect(second.relativePath).toBe("Client a/Website redesign/Lawyer-pack-2026-12-23 (2).pdf");
    expect(existsSync(join(archiveDir, first.relativePath))).toBe(true);
  });

  it("downloads over HTTP as a PDF attachment", async () => {
    const response = await lawyerPackHandlers(deps()).post(
      new Request("http://app.test/x", { method: "POST" }),
      { params: Promise.resolve({ id: PROJECT }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="Lawyer-pack-2026-12-23',
    );
    expect(response.headers.get("x-pack-pages")).toBe("6");
    expect(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  });

  it("lists what couldn't be used and still builds: no PDF saved, a missing file, a file that isn't a PDF", async () => {
    await handle.db.query(
      "UPDATE public.invoice_archive_files SET relative_path = 'Client a/Website redesign/gone.pdf' WHERE invoice_id = $1 AND version = 2",
      [INVOICE],
    );
    put("Client a/Website redesign/Demands/FPR-1-demand-2026-12-21.pdf", Buffer.from("not a pdf"));
    const pack = await build();
    expect(pack.notIncluded.join(" | ")).toMatch(/Invoice .*: the file could not be found/);
    expect(pack.notIncluded.join(" | ")).toContain(
      "FPR-1-demand-2026-12-21.pdf: the file is not a readable PDF",
    );
    expect(await sizesOf(pack.bytes)).toEqual([
      SIZES.cover,
      SIZES.agreement,
      SIZES.agreement,
      SIZES.timeline,
      SIZES.demand,
    ]);
    await handle.db.query("DELETE FROM public.invoice_archive_files WHERE invoice_id = $1", [
      INVOICE,
    ]);
    expect((await build()).notIncluded.join(" | ")).toContain("no PDF has been saved");
  });

  it("stays within the page limit and says what it left out", async () => {
    put("Client a/Website redesign/FPR-1 (v2).pdf", await makePdf(SIZES.invoiceNew, PAGE_LIMIT));
    const pack = await build();
    expect(pack.pages).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(pack.notIncluded.join(" | ")).toContain(
      `left out to keep the pack within ${String(PAGE_LIMIT)} pages`,
    );
    expect(await sizesOf(pack.bytes)).not.toContain(SIZES.invoiceNew);
    expect(await sizesOf(pack.bytes)).toContain(SIZES.agreement);
  });
});

describe("the cover's statutory calculation", () => {
  // GBP 2,000.00 due 8 Dec 2026, on 23 Dec 2026: 15 days; 4.00% + 8.00% = 12.00%; 200,000 × 1,200 × 15 ÷ 3,650,000 = 986 cents.
  it("shows interest and compensation under an approved law", async () => {
    laws = UK_LAW ? [UK_LAW] : [];
    await handle.db.query("UPDATE public.clients SET country = 'GB' WHERE id = $1", [
      USER_A.rows.clients,
    ]);
    await handle.db.query(
      "UPDATE public.invoices SET currency = 'GBP', amount_cents = 200000 WHERE id = $1",
      [INVOICE],
    );
    await build();
    expect(cover()).toContain("under Test Late Payment Act: interest GBP 9.86");
    expect(cover()).toContain("fixed compensation GBP 70.00; total GBP 2,079.86.");
    // The seeded invoice has a payment recorded by hand: the cover says how it was paid.
    expect(cover()).toContain("<td>Bank transfer</td>");
  });

  it("says plainly that none is calculated when no approved law applies, and skips invoices that aren't overdue or are paid", async () => {
    await build();
    expect(cover()).toContain(
      "no approved law applies, so no interest or compensation is calculated",
    );
    await handle.db.query(
      "UPDATE public.invoices SET status = 'paid', amount_paid_cents = amount_cents WHERE id = $1",
      [INVOICE],
    );
    await build();
    expect(cover()).toContain("No overdue, unpaid invoice.");
  });
});

describe("what goes in the timeline", () => {
  it("has every email sent, reply received and event, in order, escaped, and nothing secret or from another user", async () => {
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, sent_at, approval_status, approved_via, draft)
       VALUES ($1, $2, 'tier2', '2026-12-10T15:00:00Z', '2026-12-10T15:00:00Z', 'approved', 'outbox', $3)`,
      [
        A,
        INVOICE,
        JSON.stringify({
          subject: "Overdue: invoice FPR-1",
          body: "Please pay <b>now</b>.",
          kind: "tier2",
          via: "template",
          model: null,
          isLocal: null,
          citation: null,
          lawId: null,
          notLegalAdvice: false,
          draftedAt: "2026-12-10T14:00:00.000Z",
        }),
      ],
    );
    await handle.db.query(
      "INSERT INTO public.messages (user_id, invoice_id, direction, body, thread_id, created_at) VALUES ($1, $2, 'in', $3, 'thread-x', '2026-12-11T10:00:00Z')",
      [A, INVOICE, 'I will pay on the 15th. <script>alert("x")</script>'],
    );
    await handle.db.query(
      "UPDATE public.users SET gmail_token_enc = 'SECRET-GMAIL-TOKEN-CIPHERTEXT' WHERE id = $1",
      [A],
    );
    await build();
    const html = timeline() + cover();
    expect(html).toContain("Firm reminder sent (Tier 2)");
    expect(html).toContain("Subject: Overdue: invoice FPR-1");
    expect(html).toContain("Please pay &lt;b&gt;now&lt;&#x2F;b&gt;.");
    expect(html).toContain("Reply from the client");
    expect(html).toContain("I will pay on the 15th. &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("invoice.created");
    expect(html.indexOf("Firm reminder sent")).toBeLessThan(html.indexOf("Reply from the client"));
    // Nothing secret: the signing-token hash, the Gmail token, and no other user's records.
    const everything = rendered.join("\n");
    for (const secret of [
      "f".repeat(64),
      "SECRET-GMAIL-TOKEN-CIPHERTEXT",
      "Client b",
      "Freelancer b",
      "client-b@example.test",
      "thread-b",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
