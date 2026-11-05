import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { moveExistingPdfs } from "@/lib/archive-existing";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { saveGmailConnection } from "@/lib/gmail-account";
import { markArchiveSent, readArchiveFile, sha256Of, stageInArchive } from "@/lib/invoice-archive";
import { invoicePdf, pdfPathFor } from "@/lib/invoice-pdfs";
import { runSender } from "@/lib/sender";
import { runAsService } from "@/lib/service-db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";

// The archive on a real folder, with real migrations and RLS. Gmail is mocked (msw), and Chromium is
// a stand-in that, like the real one, makes different bytes every time.

let handle: TestDatabase;
let gmail: FakeGmail;
let root: string;
let archiveDir: string;
let pdfDir: string;
let renders = 0;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const NOW = new Date("2026-12-23T15:00:00Z");
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-ARCHIVE-0001";
const { invoices: INVOICE, reminders: REMINDER } = USER_A.rows;
const NUMBER = "FPR-ARCHIVE-1";
const PATH_V1 = `Client a/Website redesign/${NUMBER}.pdf`;
const PATH_V2 = `Client a/Website redesign/${NUMBER} (v2).pdf`;

const runner =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const asA = runner(USER_A.userId);

const pdfDeps = (userId: string = USER_A.userId) => ({
  runAsUser: runner(userId),
  renderPdf: () => {
    renders += 1;
    return Promise.resolve(Buffer.from(`%PDF-1.7 made at render ${String(renders)}`));
  },
  dir: pdfDir,
  archiveDir,
});

const senderDeps = () => ({
  runAsService: <T>(work: Parameters<typeof runAsService<T>>[1]) => runAsService(handle.db, work),
  runAsUser: runner,
  now: () => NOW,
  box: () => box,
  oauth: () => ({ clientId: "fake-client-id", clientSecret: "fake-client-secret" }),
  allowlist: () => new Set(["client-a@example.test"]),
  pdf: (userId: string, invoiceId: string) => invoicePdf(pdfDeps(userId), invoiceId),
  archive: {
    stage: (userId: string, invoiceId: string, file: Parameters<typeof stageInArchive>[2]) =>
      stageInArchive({ runAsUser: runner(userId), dir: archiveDir }, invoiceId, file),
    markSent: (userId: string, fileId: string, at: Date) =>
      markArchiveSent(runner(userId), fileId, at),
  },
});

type FileRow = {
  version: number;
  relative_path: string;
  sha256: string;
  source_sha256: string | null;
  template_name: string | null;
  signed: boolean;
  sent_at: Date | string | null;
};

const files = async (invoiceId = INVOICE): Promise<FileRow[]> =>
  (
    await handle.db.query<FileRow>(
      `SELECT version, relative_path, sha256, source_sha256, template_name, signed, sent_at
       FROM public.invoice_archive_files WHERE invoice_id = $1 ORDER BY version`,
      [invoiceId],
    )
  ).rows;

const onDisk = (relative: string) => join(archiveDir, ...relative.split("/"));

/** Makes this approved reminder due, the way a freelancer's approval does. */
const approveReminder = (id = REMINDER) =>
  handle.db.query(
    `UPDATE public.reminders SET approval_status = 'approved', approved_via = 'outbox', sent_at = NULL,
       send_attempted_at = NULL, send_blocked_reason = NULL, scheduled_at = '2026-12-23T14:00:00Z',
       draft = $2 WHERE id = $1`,
    [
      id,
      JSON.stringify({
        subject: "Invoice overdue",
        body: `Hello, please pay here: ${PAY_LINK}`,
        kind: "tier1",
        via: "template",
        model: null,
        isLocal: null,
        citation: null,
        lawId: null,
        notLegalAdvice: false,
        draftedAt: "2026-12-22T14:00:00.000Z",
      }),
    ],
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  renders = 0;
  root = await mkdtemp(join(tmpdir(), "fpr-archive-"));
  archiveDir = join(root, "archive");
  pdfDir = join(root, "working");
  gmail = createFakeGmail();
  server.resetHandlers(...gmail.handlers);
  await handle.db.query("DELETE FROM public.messages WHERE gmail_message_id IS NOT NULL");
  await handle.db.query("ALTER TABLE public.invoice_archive_files DISABLE ROW LEVEL SECURITY");
  await handle.db.query("DELETE FROM public.invoice_archive_files");
  await handle.db.query("ALTER TABLE public.invoice_archive_files ENABLE ROW LEVEL SECURITY");
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent', link = $1, invoice_number = $2, pdf_path = NULL,
       pdf_source_sha256 = NULL, amount_paid_cents = 0, gmail_thread_id = NULL, gmail_thread_subject = NULL
     WHERE id = '${INVOICE}'`,
    [PAY_LINK, NUMBER],
  );
  await handle.db.query(`UPDATE public.users SET business_name = NULL`);
  await runAsUser(handle.db, USER_A.userId, (db) =>
    saveGmailConnection(db, {
      userId: USER_A.userId,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );
  await approveReminder();
});

afterEach(async () => {
  server.resetHandlers();
  await rm(root, { recursive: true, force: true });
});

describe("sending a reminder", () => {
  it("saves the PDF at the expected path, with a matching sha256", async () => {
    expect(await runSender(senderDeps())).toMatchObject({ sent: 1 });
    const [file] = await files();
    expect(file?.relative_path).toBe(PATH_V1);
    expect(file?.version).toBe(1);
    const bytes = await readFile(onDisk(PATH_V1));
    expect(file?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("attaches exactly the file it saved", async () => {
    await runSender(senderDeps());
    const bytes = await readFile(onDisk(PATH_V1));
    const raw = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(raw.replace(/\r\n/g, "")).toContain(bytes.toString("base64"));
  });

  it("records when it went, and what it was", async () => {
    await runSender(senderDeps());
    const [file] = await files();
    expect(new Date(file?.sent_at ?? 0).toISOString()).toBe(NOW.toISOString());
    expect(file?.template_name).toBe("Classic");
    expect(file?.signed).toBe(false);
  });

  it("doesn't make a new version when the same document goes again", async () => {
    await runSender(senderDeps());
    const before = statSync(onDisk(PATH_V1)).mtimeMs;
    await approveReminder();
    await runSender(senderDeps());
    expect(gmail.state.sent).toHaveLength(2);
    expect(await files()).toHaveLength(1);
    expect(statSync(onDisk(PATH_V1)).mtimeMs).toBe(before);
    expect(renders).toBe(1);
  });

  it("saves a changed document as v2, and doesn't touch v1", async () => {
    await runSender(senderDeps());
    const v1Bytes = await readFile(onDisk(PATH_V1));
    const v1Time = statSync(onDisk(PATH_V1)).mtimeMs;

    await handle.db.query(
      `UPDATE public.users SET business_name = 'A new name' WHERE id = '${USER_A.userId}'`,
    );
    await approveReminder();
    await runSender(senderDeps());

    const rows = await files();
    expect(rows.map((file) => [file.version, file.relative_path])).toEqual([
      [1, PATH_V1],
      [2, PATH_V2],
    ]);
    expect(await readFile(onDisk(PATH_V1))).toEqual(v1Bytes);
    expect(statSync(onDisk(PATH_V1)).mtimeMs).toBe(v1Time);
    expect(rows[1]?.sha256).toBe(sha256Of(await readFile(onDisk(PATH_V2))));
    expect(rows[0]?.sha256).not.toBe(rows[1]?.sha256);
  });

  it("holds the reminder if the PDF can't be saved: nothing goes without a copy", async () => {
    await writeFile(join(root, "not-a-folder"), "x");
    archiveDir = join(root, "not-a-folder", "archive");
    expect(await runSender(senderDeps())).toMatchObject({ sent: 0, held: 1 });
    expect(gmail.state.sent).toEqual([]);
    const { rows } = await handle.db.query<{ send_blocked_reason: string }>(
      `SELECT send_blocked_reason FROM public.reminders WHERE id = '${REMINDER}'`,
    );
    expect(rows[0]?.send_blocked_reason).toBe("archive_failed");
  });

  it("sends it once the folder is fixed", async () => {
    await writeFile(join(root, "not-a-folder"), "x");
    const good = archiveDir;
    archiveDir = join(root, "not-a-folder", "archive");
    await runSender(senderDeps());
    archiveDir = good;
    expect(await runSender(senderDeps())).toMatchObject({ sent: 1 });
    expect(existsSync(onDisk(PATH_V1))).toBe(true);
  });

  it("keeps the file, unmarked as sent, if Gmail refuses it", async () => {
    gmail.state.sendFailure = 400;
    await runSender(senderDeps());
    const [file] = await files();
    expect(file?.sent_at).toBeNull();
    expect(existsSync(onDisk(PATH_V1))).toBe(true);
  });
});

describe("never overwriting", () => {
  const facts = (text: string, sourceSha256 = sha256Of(text)) => ({
    pdf: Buffer.from(text),
    sourceSha256,
    templateName: "Classic",
    signed: false,
  });
  const deps = () => ({ runAsUser: asA, dir: archiveDir });

  it("leaves a file that's already at the name, and takes the next version", async () => {
    await mkdir(dirname(onDisk(PATH_V1)), { recursive: true });
    await writeFile(onDisk(PATH_V1), "someone else's file");
    await stageInArchive(deps(), INVOICE, facts("the invoice"));
    expect(await readFile(onDisk(PATH_V1), "utf8")).toBe("someone else's file");
    expect(await readFile(onDisk(PATH_V2), "utf8")).toBe("the invoice");
    expect((await files())[0]?.relative_path).toBe(PATH_V2);
  });

  it("makes a new version if a kept file has gone missing", async () => {
    await stageInArchive(deps(), INVOICE, facts("the invoice"));
    await rm(onDisk(PATH_V1));
    await stageInArchive(deps(), INVOICE, facts("the invoice"));
    expect((await files()).map((file) => file.version)).toEqual([1, 2]);
  });

  it("records the first sent time, and keeps it", async () => {
    const id = await stageInArchive(deps(), INVOICE, facts("the invoice"));
    await markArchiveSent(asA, id, NOW);
    await markArchiveSent(asA, id, new Date("2027-01-01T00:00:00Z"));
    expect(new Date((await files())[0]?.sent_at ?? 0).toISOString()).toBe(NOW.toISOString());
  });

  it("refuses an archive folder inside this repository", async () => {
    await expect(
      stageInArchive(
        { runAsUser: asA, dir: join(process.cwd(), "invoices-to-commit") },
        INVOICE,
        facts("x"),
      ),
    ).rejects.toThrow(/git repository/);
    expect(existsSync(join(process.cwd(), "invoices-to-commit"))).toBe(false);
  });
});

describe("unsafe names on the way to the disk", () => {
  it("keeps a hostile client and project name inside the folder", async () => {
    await handle.db.query(
      `UPDATE public.clients SET name = '../../../evil' WHERE id = '${USER_A.rows.clients}'`,
    );
    await handle.db.query(
      `UPDATE public.projects SET title = '..\\..\\CON' WHERE id = '${USER_A.rows.projects}'`,
    );
    try {
      await runSender(senderDeps());
      const [file] = await files();
      expect(file?.relative_path).toBe(`evil/_CON/${NUMBER}.pdf`);
      expect(existsSync(onDisk(file?.relative_path ?? ""))).toBe(true);
      expect(existsSync(join(root, "..", "..", "evil"))).toBe(false);
    } finally {
      await handle.db.query(
        `UPDATE public.clients SET name = 'Client a' WHERE id = '${USER_A.rows.clients}'`,
      );
      await handle.db.query(
        `UPDATE public.projects SET title = 'Website redesign' WHERE id = '${USER_A.rows.projects}'`,
      );
    }
  });
});

describe("reading a file back", () => {
  it("reads what's inside the folder", async () => {
    await mkdir(join(archiveDir, "Client"), { recursive: true });
    await writeFile(join(archiveDir, "Client", "a.pdf"), "pdf");
    expect((await readArchiveFile(archiveDir, "Client/a.pdf"))?.toString()).toBe("pdf");
  });

  it("gives nothing for a path outside it, even if the file exists", async () => {
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(root, "secret.pdf"), "secret");
    expect(await readArchiveFile(archiveDir, "../secret.pdf")).toBeUndefined();
  });

  it("gives nothing for a link inside the folder that leads out of it", async (context) => {
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(root, "secret.pdf"), "secret");
    try {
      await symlink(join(root, "secret.pdf"), join(archiveDir, "link.pdf"));
    } catch {
      context.skip(); // Windows only lets an administrator make one.
    }
    expect(await readArchiveFile(archiveDir, "link.pdf")).toBeUndefined();
  });

  it("gives nothing for a file that's gone", async () => {
    await mkdir(archiveDir, { recursive: true });
    expect(await readArchiveFile(archiveDir, "gone.pdf")).toBeUndefined();
  });
});

describe("the working copy", () => {
  it("is reused while the document stays the same", async () => {
    await invoicePdf(pdfDeps(), INVOICE);
    await invoicePdf(pdfDeps(), INVOICE);
    expect(renders).toBe(1);
  });

  it("is made again when the document changes", async () => {
    await invoicePdf(pdfDeps(), INVOICE);
    await handle.db.query(
      `UPDATE public.users SET invoice_paper = 'Letter' WHERE id = '${USER_A.userId}'`,
    );
    await invoicePdf(pdfDeps(), INVOICE);
    await handle.db.query(`UPDATE public.users SET invoice_paper = 'A4'`);
    expect(renders).toBe(2);
  });

  it("is not the archive: making a PDF saves nothing there until it's sent", async () => {
    await invoicePdf(pdfDeps(), INVOICE);
    expect(await files()).toEqual([]);
    expect(existsSync(archiveDir)).toBe(false);
  });
});

describe("moving PDFs from before the archive", () => {
  const place = async (invoiceId = INVOICE, userId: string = USER_A.userId) => {
    const relative = pdfPathFor(userId, invoiceId);
    const file = join(pdfDir, ...relative.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `%PDF old ${invoiceId}`);
    await handle.db.query("UPDATE public.invoices SET pdf_path = $2 WHERE id = $1", [
      invoiceId,
      relative,
    ]);
    return file;
  };
  const move = () => moveExistingPdfs(handle.db, { pdfDirs: [pdfDir], archiveDir });

  it("moves each one into the layout, with its checksum and first sent time", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET sent_at = '2026-12-01T10:00:00Z' WHERE id = '${REMINDER}'`,
    );
    const source = await place();
    expect(await move()).toEqual({ moved: 1, missing: 0, alreadyThere: 0 });
    expect(existsSync(source)).toBe(false);
    const [file] = await files();
    expect(file?.relative_path).toBe(PATH_V1);
    expect(file?.source_sha256).toBeNull();
    expect(file?.sha256).toBe(sha256Of(`%PDF old ${INVOICE}`));
    expect(new Date(file?.sent_at ?? 0).toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(await readFile(onDisk(PATH_V1), "utf8")).toBe(`%PDF old ${INVOICE}`);
  });

  it("is safe to run again", async () => {
    await place();
    await move();
    expect(await move()).toEqual({ moved: 0, missing: 0, alreadyThere: 0 });
    expect(await files()).toHaveLength(1);
  });

  it("finishes the job if a run stopped after copying", async () => {
    const source = await place();
    await move();
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, `%PDF old ${INVOICE}`);
    await handle.db.query("UPDATE public.invoices SET pdf_path = $2 WHERE id = $1", [
      INVOICE,
      pdfPathFor(USER_A.userId, INVOICE),
    ]);
    expect(await move()).toEqual({ moved: 0, missing: 0, alreadyThere: 1 });
    expect(await files()).toHaveLength(1);
    expect(existsSync(source)).toBe(false);
  });

  it("doesn't overwrite a file already at the name", async () => {
    await mkdir(dirname(onDisk(PATH_V1)), { recursive: true });
    await writeFile(onDisk(PATH_V1), "already here");
    await place();
    await move();
    expect(await readFile(onDisk(PATH_V1), "utf8")).toBe("already here");
    expect((await files())[0]?.relative_path).toBe(PATH_V2);
  });

  it("counts one with no file, and stops pointing at it", async () => {
    await handle.db.query("UPDATE public.invoices SET pdf_path = $2 WHERE id = $1", [
      INVOICE,
      pdfPathFor(USER_A.userId, INVOICE),
    ]);
    expect(await move()).toEqual({ moved: 0, missing: 1, alreadyThere: 0 });
    const { rows } = await handle.db.query<{ pdf_path: string | null }>(
      `SELECT pdf_path FROM public.invoices WHERE id = '${INVOICE}'`,
    );
    expect(rows[0]?.pdf_path).toBeNull();
  });
});

describe("the archive's rows", () => {
  const insert = () =>
    asA((db) =>
      db.query(
        `INSERT INTO public.invoice_archive_files (user_id, invoice_id, version, relative_path, sha256)
         VALUES ((SELECT auth.uid()), $1, 1, 'Client/x.pdf', $2) RETURNING id::text`,
        [INVOICE, "a".repeat(64)],
      ),
    );

  it("can't be read by another user", async () => {
    await insert();
    const { rows } = await runner(USER_B.userId)((db) =>
      db.query("SELECT id FROM public.invoice_archive_files"),
    );
    expect(rows).toEqual([]);
  });

  it("can't be written for another user's invoice", async () => {
    await expect(
      runner(USER_B.userId)((db) =>
        db.query(
          `INSERT INTO public.invoice_archive_files (user_id, invoice_id, version, relative_path, sha256)
           VALUES ($1, $2, 1, 'Client/x.pdf', $3)`,
          [USER_A.userId, INVOICE, "a".repeat(64)],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't be deleted, even by their owner", async () => {
    await insert();
    await expect(asA((db) => db.query("DELETE FROM public.invoice_archive_files"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it.each([
    ["path", "relative_path = 'Other/x.pdf'"],
    ["checksum", `sha256 = '${"b".repeat(64)}'`],
    ["version", "version = 9"],
  ])("can't have their %s changed, even by their owner", async (_what, change) => {
    await insert();
    await expect(
      asA((db) => db.query(`UPDATE public.invoice_archive_files SET ${change}`)),
    ).rejects.toThrow(/permission denied/);
  });
});
