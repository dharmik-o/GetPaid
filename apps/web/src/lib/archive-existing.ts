import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { archiveRelativePath, resolveInsideArchive } from "./archive-paths";
import type { Db } from "./db";
import { sha256Of } from "./invoice-archive";
import { workingCopyPath } from "./invoice-pdfs";

// Server-only: moves PDFs made before the archive existed into its layout. Run once with
// `npm run invoices:archive-existing`, as the database owner, since it spans every account. Safe to
// run again: a PDF already moved has no working copy left, so it's skipped.

export type MoveResult = { moved: number; missing: number; alreadyThere: number };

type Row = {
  id: string;
  user_id: string;
  invoice_number: string;
  pdf_path: string;
  include_signature: boolean;
  client_name: string;
  project_title: string | null;
  template_name: string | null;
  first_sent_at: Date | string | null;
};

const PENDING = `
  SELECT i.id::text, i.user_id::text, i.invoice_number, i.pdf_path, i.include_signature,
    c.name AS client_name, p.title AS project_title, t.name AS template_name,
    (SELECT min(r.sent_at) FROM public.reminders r WHERE r.invoice_id = i.id) AS first_sent_at
  FROM public.invoices i
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
  LEFT JOIN public.invoice_templates t ON t.id = i.template_id
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  WHERE i.pdf_path IS NOT NULL
  ORDER BY i.created_at`;

const clearWorkingCopy = (db: Db, id: string) =>
  db.query("UPDATE public.invoices SET pdf_path = NULL, pdf_source_sha256 = NULL WHERE id = $1", [
    id,
  ]);

/** The first of `dirs` that holds this working copy: the app and a script run from different folders. */
const findWorkingCopy = (dirs: readonly string[], relative: string): string | undefined =>
  dirs.map((dir) => workingCopyPath(dir, relative)).find((file) => existsSync(file));

type Existing = { version: number; sha256: string };

const moveOne = async (
  db: Db,
  row: Row,
  source: string,
  archiveDir: string,
): Promise<"moved" | "alreadyThere"> => {
  const pdf = await readFile(source);
  const sha256 = sha256Of(pdf);
  const { rows } = await db.query<Existing>(
    "SELECT version, sha256 FROM public.invoice_archive_files WHERE invoice_id = $1",
    [row.id],
  );
  if (rows.some((file) => file.sha256 === sha256)) {
    await clearWorkingCopy(db, row.id);
    await unlink(source);
    return "alreadyThere";
  }
  let version = Math.max(0, ...rows.map((file) => file.version)) + 1;
  let relativePath: string;
  let target: string | undefined;
  for (; ; version += 1) {
    relativePath = archiveRelativePath({
      clientName: row.client_name,
      projectTitle: row.project_title,
      invoiceNumber: row.invoice_number,
      version,
    });
    target = resolveInsideArchive(archiveDir, relativePath);
    if (!target) throw new Error("An invoice's archive path didn't stay inside the folder.");
    if (!existsSync(target)) break;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await db.query(
    `INSERT INTO public.invoice_archive_files
       (user_id, invoice_id, version, relative_path, sha256, template_name, signed, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.user_id,
      row.id,
      version,
      relativePath,
      sha256,
      row.template_name,
      row.include_signature,
      row.first_sent_at === null ? null : new Date(row.first_sent_at).toISOString(),
    ],
  );
  await clearWorkingCopy(db, row.id);
  // Last, so a failure above leaves the original where it was, for the next run.
  await unlink(source);
  return "moved";
};

export const moveExistingPdfs = async (
  db: Db,
  { pdfDirs, archiveDir }: { pdfDirs: readonly string[]; archiveDir: string },
): Promise<MoveResult> => {
  const result: MoveResult = { moved: 0, missing: 0, alreadyThere: 0 };
  const { rows } = await db.query<Row>(PENDING);
  for (const row of rows) {
    const source = findWorkingCopy(pdfDirs, row.pdf_path);
    if (!source) {
      await clearWorkingCopy(db, row.id);
      result.missing += 1;
      continue;
    }
    result[await moveOne(db, row, source, archiveDir)] += 1;
  }
  return result;
};
