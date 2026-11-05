import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { archiveDirProblem, archiveRelativePath, resolveInsideArchive } from "./archive-paths";
import type { Db, UserDbRunner } from "./db";

// Server-only: the folder of every invoice PDF sent to a client. A file is written before Gmail is
// called, so nothing goes out without a copy kept, and is opened so that an existing file can't be
// replaced. A changed document becomes the next version, and every earlier one stays. Rows are read
// and written as the freelancer (RLS).

export type ArchiveDeps = { runAsUser: UserDbRunner; dir: string };

/** What a PDF is, beyond its bytes. */
export type PdfFacts = {
  pdf: Buffer;
  /** Of the document it was made from: the same document can make PDFs with different bytes. */
  sourceSha256: string;
  templateName: string | null;
  signed: boolean;
};

export const sha256Of = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** How many other files can hold a version's name before this gives up and says so. */
const NAME_ATTEMPTS = 25;

type Names = { invoice_number: string; client_name: string; project_title: string | null };

const loadNames = async (db: Db, invoiceId: string): Promise<Names | undefined> => {
  const { rows } = await db.query<Names>(
    `SELECT i.invoice_number, c.name AS client_name, p.title AS project_title
     FROM public.invoices i
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
     WHERE i.id = $1`,
    [invoiceId],
  );
  return rows[0];
};

type Latest = { id: string; version: number; relative_path: string; source_sha256: string | null };

const loadLatest = async (db: Db, invoiceId: string): Promise<Latest | undefined> => {
  const { rows } = await db.query<Latest>(
    `SELECT id::text, version, relative_path, source_sha256 FROM public.invoice_archive_files
     WHERE invoice_id = $1 ORDER BY version DESC LIMIT 1`,
    [invoiceId],
  );
  return rows[0];
};

const isTaken = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/** Writes the next free version. A name already on disk is left alone, and the next one tried. */
const writeNewVersion = async (
  dir: string,
  names: Names,
  firstVersion: number,
  pdf: Buffer,
): Promise<{ version: number; relativePath: string }> => {
  for (let version = firstVersion; version < firstVersion + NAME_ATTEMPTS; version += 1) {
    const relativePath = archiveRelativePath({
      clientName: names.client_name,
      projectTitle: names.project_title,
      invoiceNumber: names.invoice_number,
      version,
    });
    const file = resolveInsideArchive(dir, relativePath);
    if (!file) throw new Error("An invoice's archive path didn't stay inside the archive folder.");
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, pdf, { flag: "wx" });
      return { version, relativePath };
    } catch (error) {
      if (!isTaken(error)) throw error;
    }
  }
  throw new Error("Too many files already have this invoice's name in the archive folder.");
};

/**
 * Keeps this PDF, ready to send: the version already there if it's the same document, else a new one.
 * Returns the file's row id, for markArchiveSent once the email has gone.
 */
export const stageInArchive = async (
  deps: ArchiveDeps,
  invoiceId: string,
  facts: PdfFacts,
): Promise<string> => {
  const problem = archiveDirProblem(deps.dir);
  if (problem) throw new Error(problem);
  const { names, latest } = await deps.runAsUser(async (db) => ({
    names: await loadNames(db, invoiceId),
    latest: await loadLatest(db, invoiceId),
  }));
  if (!names) throw new Error("The invoice to archive wasn't found.");
  if (latest?.source_sha256 === facts.sourceSha256) {
    const kept = resolveInsideArchive(deps.dir, latest.relative_path);
    if (kept && existsSync(kept)) return latest.id;
  }
  const { version, relativePath } = await writeNewVersion(
    deps.dir,
    names,
    (latest?.version ?? 0) + 1,
    facts.pdf,
  );
  return deps.runAsUser(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.invoice_archive_files
         (user_id, invoice_id, version, relative_path, sha256, source_sha256, template_name, signed)
       VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text`,
      [
        invoiceId,
        version,
        relativePath,
        sha256Of(facts.pdf),
        facts.sourceSha256,
        facts.templateName,
        facts.signed,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("The archive file's row could not be saved.");
    return id;
  });
};

/** The first time it went: later reminders that carry the same file don't change this. */
export const markArchiveSent = async (
  runAsUser: UserDbRunner,
  fileId: string,
  sentAt: Date,
): Promise<void> => {
  await runAsUser((db) =>
    db.query(
      `UPDATE public.invoice_archive_files SET sent_at = $2
       WHERE id = $1 AND sent_at IS NULL`,
      [fileId, sentAt.toISOString()],
    ),
  );
};

/**
 * A file from the archive, or undefined if it's gone or isn't inside the folder. A link inside the
 * folder can't lead out of it: the real path is checked as well as the stored one.
 */
export const readArchiveFile = async (
  dir: string,
  relativePath: string,
): Promise<Buffer | undefined> => {
  const file = resolveInsideArchive(dir, relativePath);
  if (!file) return undefined;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(resolve(dir)), realpath(file)]);
    const within = relative(realRoot, realFile);
    if (!within || within.startsWith("..") || isAbsolute(within)) return undefined;
    return await readFile(realFile);
  } catch {
    return undefined;
  }
};

/** The kept PDF of this exact document, if there is one. */
export const findArchivedPdf = async (
  deps: ArchiveDeps,
  invoiceId: string,
  sourceSha256: string,
): Promise<Buffer | undefined> => {
  const relativePath = await deps.runAsUser(async (db) => {
    const { rows } = await db.query<{ relative_path: string }>(
      `SELECT relative_path FROM public.invoice_archive_files
       WHERE invoice_id = $1 AND source_sha256 = $2 ORDER BY version DESC LIMIT 1`,
      [invoiceId, sourceSha256],
    );
    return rows[0]?.relative_path;
  });
  return relativePath ? readArchiveFile(deps.dir, relativePath) : undefined;
};
