import { join } from "node:path";
import pg from "pg";
import { archiveDirProblem, defaultArchiveDir } from "../apps/web/src/lib/archive-paths";
import { moveExistingPdfs } from "../apps/web/src/lib/archive-existing";
import { fromPg } from "./lib/sql-client";

// `npm run invoices:archive-existing`: moves PDFs made before the archive into its layout. Safe to
// run again. It prints only counts and the folder, never a client's name.

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const main = async (): Promise<void> => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your local env file (see .env.example), then run this again.",
    );
  }
  const archiveDir = defaultArchiveDir();
  const problem = archiveDirProblem(archiveDir);
  if (problem) throw new Error(problem);
  const chosen = process.env.INVOICE_PDF_DIR;
  // The app keeps working copies under apps/web, and this runs from the repo root.
  const pdfDirs = chosen
    ? [chosen]
    : [
        join(process.cwd(), "apps", "web", ".data", "invoice-pdfs"),
        join(process.cwd(), ".data", "invoice-pdfs"),
      ];
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { moved, alreadyThere, missing } = await moveExistingPdfs(fromPg(client), {
      pdfDirs,
      archiveDir,
    });
    say(`Archive folder: ${archiveDir}`);
    say(
      `Moved ${String(moved)}, already there ${String(alreadyThere)}, no file found ${String(missing)}.`,
    );
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
