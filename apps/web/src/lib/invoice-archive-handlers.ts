import { isUuid, type UserDbRunner } from "./db";
import { notFound, serverError } from "./http";
import { readArchiveFile } from "./invoice-archive";
import { logEvent } from "./log";

// Server-only: GET /api/invoices/[id]/versions/[version], a PDF from the archive. The row is read as
// the signed-in user, so another user's invoice isn't found, and the file is only read from inside
// INVOICE_ARCHIVE_DIR, whatever the row says.

type Deps = () => { runAsUser: UserDbRunner; dir: string };
type Context = { params: Promise<{ id: string; version: string }> };

const SAVED_FILE = "Saved invoice file";
const VERSION = /^[1-9]\d{0,5}$/;

/** A header can't carry a line break or a quote, and this keeps it plain ASCII for every browser. */
const downloadName = (relativePath: string): string =>
  (relativePath.split("/").at(-1) ?? "invoice.pdf").replace(/[^A-Za-z0-9 ._()-]/g, "");

export const archiveDownloadHandler = (deps: Deps) => ({
  get: async (_request: Request, { params }: Context): Promise<Response> => {
    const { id, version } = await params;
    if (!isUuid(id) || !VERSION.test(version)) return notFound(SAVED_FILE);
    try {
      const { runAsUser, dir } = deps();
      const relativePath = await runAsUser(async (db) => {
        const { rows } = await db.query<{ relative_path: string }>(
          `SELECT relative_path FROM public.invoice_archive_files
           WHERE invoice_id = $1 AND version = $2`,
          [id, Number(version)],
        );
        return rows[0]?.relative_path;
      });
      if (!relativePath) return notFound(SAVED_FILE);
      const pdf = await readArchiveFile(dir, relativePath);
      if (!pdf) {
        logEvent("invoice_archive.file_missing", { invoiceId: id, version });
        return notFound(SAVED_FILE);
      }
      return new Response(new Uint8Array(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${downloadName(relativePath)}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return serverError("invoice_archive.download_failed", error);
    }
  },
});
