import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Mustache from "mustache";
import { sha256Hex } from "./agreement-email";
import type { Agreement } from "./agreements";
import { agreementRelativePath, archiveDirProblem, resolveInsideArchive } from "./archive-paths";
import type { Db } from "./db";
import type { PdfFile } from "./invoice-pdfs";

// Server-only: the signed agreement as a PDF (the document, then a certificate page) and its place
// in the invoice archive folder. The certificate is the evidence: who signed, when, from where, and
// which document (by its SHA-256). Every value is HTML-escaped. Pure except for the file write.

export type SignedFacts = {
  agreement: Agreement;
  signerName: string;
  signerEmail: string;
  signerIp: string;
  signerUserAgent: string;
  signedAt: Date;
  freelancerZone: string;
  clientZone: string;
};

const when = (instant: Date, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "long", timeZone: zone }).format(
    instant,
  );

const row = (label: string, value: string): string =>
  `<tr><th>${Mustache.escape(label)}</th><td>${Mustache.escape(value)}</td></tr>`;

const CERTIFICATE_STYLE =
  "<style>.certificate{page-break-before:always}.certificate table{border-collapse:collapse;width:100%}" +
  ".certificate th{width:30%;text-align:left}.certificate th,.certificate td{border:1px solid #999;padding:.3em .5em;vertical-align:top;word-break:break-word}</style>";

/** The agreement as it was sent, followed by its certificate page. */
export const signedDocumentHtml = (facts: SignedFacts): string => {
  const { agreement: a } = facts;
  const parties = a.facts;
  const certificate = [
    CERTIFICATE_STYLE,
    '<div class="certificate"><h1>Certificate of electronic signature</h1>',
    `<p>${Mustache.escape(
      "Both parties agreed to sign this agreement electronically. The Freelancer signed by typing their full name when sending it, and the Client by typing their full name and ticking the box to agree.",
    )}</p><table>`,
    row("Agreement", `${a.number}, version ${String(a.version)}`),
    row("Project", parties.project.title),
    row("Freelancer", a.freelancerSignedName ?? parties.freelancer.legalName),
    row(
      "Freelancer signed",
      a.freelancerSignedAt
        ? `${when(new Date(a.freelancerSignedAt), "UTC")} (UTC)`
        : "Not recorded",
    ),
    row(
      "Freelancer's time",
      a.freelancerSignedAt
        ? when(new Date(a.freelancerSignedAt), facts.freelancerZone)
        : "Not recorded",
    ),
    row("Client", facts.signerName),
    row("Client email", facts.signerEmail),
    row("Client signed", `${when(facts.signedAt, "UTC")} (UTC)`),
    row("Client's time", when(facts.signedAt, facts.clientZone)),
    row("Client's IP address", facts.signerIp),
    row("Client's browser", facts.signerUserAgent),
    row("Document SHA-256", a.bodySha256),
    "</table></div>",
  ].join("");
  return a.bodyHtml.replace("</body>", `${certificate}</body>`);
};

/** The signed PDF. The renderer is injected (Chromium in the app, a fake in tests). */
export const renderSignedPdf = (
  facts: SignedFacts,
  render: (html: string) => Promise<Buffer>,
): Promise<Buffer> => render(signedDocumentHtml(facts));

const NAME_ATTEMPTS = 25;

const isTaken = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/**
 * Keeps the signed PDF in the archive folder and returns its relative path and SHA-256. An
 * existing file is never replaced: a taken name gets "(2)", "(3)".
 */
export const saveSignedPdf = async (
  dir: string,
  agreement: Agreement,
  pdf: Buffer,
): Promise<{ relativePath: string; sha256: string }> => {
  const problem = archiveDirProblem(dir);
  if (problem) throw new Error(problem);
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const relativePath = agreementRelativePath({
      clientName: agreement.facts.client.name,
      projectTitle: agreement.facts.project.title,
      number: agreement.number,
      version: agreement.version,
      attempt,
    });
    const file = resolveInsideArchive(dir, relativePath);
    if (!file)
      throw new Error("An agreement's archive path didn't stay inside the archive folder.");
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, pdf, { flag: "wx" });
      return { relativePath, sha256: sha256Hex(pdf) };
    } catch (error) {
      if (!isTaken(error)) throw error;
    }
  }
  throw new Error("Too many files already have this agreement's name in the archive folder.");
};

/** The signed PDF's bytes, read only from inside the archive folder. Undefined if it isn't there. */
export const readSignedPdf = async (
  dir: string,
  relativePath: string | null,
): Promise<Buffer | undefined> => {
  if (!relativePath) return undefined;
  const file = resolveInsideArchive(dir, relativePath);
  if (!file) return undefined;
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
};

/** The signed PDF as an email attachment, for the signed-copy email. Undefined if it can't be read. */
export const signedPdfFile = async (
  db: Db,
  dir: string,
  agreementId: string,
): Promise<PdfFile | undefined> => {
  const { rows } = await db.query<{ number: string; signed_pdf_path: string | null }>(
    "SELECT number, signed_pdf_path FROM public.agreements WHERE id = $1 AND status = 'signed'",
    [agreementId],
  );
  const row = rows[0];
  const pdf = row ? await readSignedPdf(dir, row.signed_pdf_path) : undefined;
  if (!row || !pdf) return undefined;
  return {
    pdf,
    sourceSha256: sha256Hex(pdf),
    templateName: null,
    signed: true,
    filename: `${row.number.replace(/[^A-Za-z0-9-]/g, "")}-signed.pdf`,
  };
};
