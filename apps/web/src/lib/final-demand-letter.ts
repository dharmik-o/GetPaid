import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Mustache from "mustache";
import { demandRelativePath, archiveDirProblem, resolveInsideArchive } from "./archive-paths";
import { sha256Hex } from "./agreement-email";
import type { Db, UserDbRunner } from "./db";
import { formatFullDay } from "./format";
import type { PdfFile } from "./invoice-pdfs";
import { todayIn } from "./schedule";
import type { StoredDraft } from "./stored-draft";
import { DOCUMENT_CSP } from "./template-render";

// Server-only: the final demand letter as a PDF, made from the draft the freelancer approved (so a
// change they made is in it), and kept in the archive folder. Plain letterhead from their own
// details. Every value is HTML-escaped. The email carries this PDF instead of the invoice's.

export type LetterData = {
  freelancer: { name: string; business: string | null; address: string | null; email: string };
  client: { name: string; company: string | null; address: string | null };
  /** "9 Nov 2026" */
  date: string;
  subject: string;
  body: string;
};

const escape = (text: string): string => Mustache.escape(text);

const lines = (parts: (string | null)[]): string =>
  parts
    .filter((part): part is string => part !== null && part !== "")
    .map(escape)
    .join("<br>");

const STYLE =
  "body{font-family:Georgia,serif;font-size:11pt;line-height:1.5;color:#111;max-width:46rem;margin:2rem auto;padding:0 1rem}" +
  ".head{border-bottom:1px solid #999;padding-bottom:.6rem;margin-bottom:1.2rem}.who{font-weight:bold;font-size:13pt}" +
  ".text{white-space:pre-wrap}";

export const letterHtml = ({ freelancer, client, date, subject, body }: LetterData): string =>
  [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">`,
    `<title>${escape(subject)}</title><style>${STYLE}</style></head><body>`,
    `<div class="head"><div class="who">${escape(freelancer.business ?? freelancer.name)}</div>`,
    `<div>${lines([freelancer.business ? freelancer.name : null, freelancer.address, freelancer.email])}</div></div>`,
    `<p>${escape(date)}</p>`,
    `<p>${lines([client.name, client.company, client.address])}</p>`,
    `<p><strong>${escape(subject)}</strong></p>`,
    `<div class="text">${escape(body)}</div>`,
    "</body></html>",
  ].join("");

type Names = {
  invoice_number: string;
  client_name: string;
  client_company: string | null;
  client_address: string | null;
  time_zone: string;
  project_title: string | null;
  freelancer_name: string;
  business_name: string | null;
  freelancer_address: string | null;
  freelancer_email: string;
};

const NAME_ATTEMPTS = 25;

const isTaken = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

export type DemandPdfDeps = {
  runAsUser: UserDbRunner;
  renderPdf: (html: string) => Promise<Buffer>;
  archiveDir: string;
  now: () => Date;
};

/**
 * The letter's PDF for an invoice, saved as <Client>/<Project>/Demands/<invoice>-demand-<date>.pdf.
 * An existing file is never replaced: a taken name gets "(2)", "(3)". Undefined if the invoice isn't found.
 */
export const demandPdfFile = async (
  deps: DemandPdfDeps,
  invoiceId: string,
  draft: StoredDraft,
): Promise<PdfFile | undefined> => {
  const names = await deps.runAsUser(async (db: Db) => {
    const { rows } = await db.query<Names>(
      `SELECT i.invoice_number, c.name AS client_name, c.company AS client_company,
         c.address AS client_address, c.time_zone, coalesce(p.title, rt.name) AS project_title,
         u.name AS freelancer_name, u.business_name, u.address AS freelancer_address,
         u.email AS freelancer_email
       FROM public.invoices i
       LEFT JOIN public.milestones m ON m.id = i.milestone_id
       LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
       LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
       JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
       JOIN public.users u ON u.id = i.user_id
       WHERE i.id = $1`,
      [invoiceId],
    );
    return rows[0];
  });
  if (!names) return undefined;
  const today = todayIn(deps.now(), names.time_zone);
  const pdf = await deps.renderPdf(
    letterHtml({
      freelancer: {
        name: names.freelancer_name,
        business: names.business_name,
        address: names.freelancer_address,
        email: names.freelancer_email,
      },
      client: {
        name: names.client_name,
        company: names.client_company,
        address: names.client_address,
      },
      date: formatFullDay(today),
      subject: draft.subject,
      body: draft.body,
    }),
  );
  const problem = archiveDirProblem(deps.archiveDir);
  if (problem) throw new Error(problem);
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const relativePath = demandRelativePath({
      clientName: names.client_name,
      projectTitle: names.project_title ?? "Retainers",
      invoiceNumber: names.invoice_number,
      date: today,
      attempt,
    });
    const file = resolveInsideArchive(deps.archiveDir, relativePath);
    if (!file)
      throw new Error("A demand letter's archive path didn't stay inside the archive folder.");
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, pdf, { flag: "wx" });
      return {
        pdf,
        sourceSha256: sha256Hex(draft.body),
        templateName: null,
        signed: false,
        filename: `demand-${names.invoice_number.replace(/[^A-Za-z0-9-]/g, "")}.pdf`,
      };
    } catch (error) {
      if (!isTaken(error)) throw error;
    }
  }
  throw new Error("Too many files already have this demand letter's name in the archive folder.");
};
