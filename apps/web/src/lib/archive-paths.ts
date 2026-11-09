import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Server-only: where the invoice archive lives, and paths in it that are safe on Windows and macOS.
// A client or project name is the freelancer's own text, and can be anything. Every path read from
// the database or built here goes through resolveInsideArchive before it reaches the disk.

const MAX_SEGMENT_CHARS = 60;
const UNNAMED = "Unnamed";
const NO_PROJECT = "Retainers";

/** Control and invisible characters, and those Windows or macOS refuse in a name. */
const UNSAFE = /[\p{Cc}\p{Cf}<>:"/\\|?*]/gu;
/** Windows refuses these whatever the case, and with any extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/iu;

/** A name as one folder or file name: never a path, and never empty. */
export const safeSegment = (name: string): string => {
  const cleaned = name
    .normalize("NFC")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "");
  // By whole characters, so an accented letter or emoji is never cut in half.
  const capped = Array.from(cleaned).slice(0, MAX_SEGMENT_CHARS).join("");
  const ended = capped.replace(/[. ]+$/, "");
  if (!ended) return UNNAMED;
  return RESERVED.test(ended) ? `_${ended}` : ended;
};

export type ArchiveName = {
  clientName: string;
  projectTitle: string | null;
  invoiceNumber: string;
  version: number;
};

/** <Client>/<Project>/FPR-000042.pdf, then "FPR-000042 (v2).pdf". Always with forward slashes. */
export const archiveRelativePath = ({
  clientName,
  projectTitle,
  invoiceNumber,
  version,
}: ArchiveName): string => {
  const number = safeSegment(invoiceNumber);
  const file = version === 1 ? `${number}.pdf` : `${number} (v${String(version)}).pdf`;
  return [
    safeSegment(clientName),
    projectTitle === null ? NO_PROJECT : safeSegment(projectTitle),
    file,
  ].join("/");
};

export type AgreementName = {
  clientName: string;
  projectTitle: string;
  number: string;
  version: number;
  /** 1 for the first try; later tries are named "(2)", "(3)" when a file already has the name. */
  attempt: number;
};

/** <Client>/<Project>/Agreements/AGR-000001-v1.pdf. Always with forward slashes. */
export const agreementRelativePath = ({
  clientName,
  projectTitle,
  number,
  version,
  attempt,
}: AgreementName): string =>
  [
    safeSegment(clientName),
    safeSegment(projectTitle),
    "Agreements",
    `${safeSegment(number)}-v${String(version)}${attempt > 1 ? ` (${String(attempt)})` : ""}.pdf`,
  ].join("/");

/** The file's full path, or undefined if it isn't a PDF inside the archive. */
export const resolveInsideArchive = (dir: string, relativePath: string): string | undefined => {
  if (!relativePath.toLowerCase().endsWith(".pdf")) return undefined;
  // Paths here always use forward slashes, so a backslash or a drive letter is never one of ours.
  if (/[\0\\]/.test(relativePath) || /^[a-z]:/i.test(relativePath)) return undefined;
  if (isAbsolute(relativePath)) return undefined;
  const root = resolve(dir);
  const full = resolve(root, relativePath);
  const within = relative(root, full);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    return undefined;
  }
  return full;
};

/** INVOICE_ARCHIVE_DIR, or <Documents>/GetPaid/Invoices. */
export const defaultArchiveDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string => {
  const chosen = env.INVOICE_ARCHIVE_DIR?.trim();
  return resolve(chosen ? chosen : join(home, "Documents", "GetPaid", "Invoices"));
};

/** Folders inside a repo that .gitignore already covers. */
const IGNORED_IN_REPO = ["invoice-archive", ".data"];

const repoRootOf = (dir: string): string | undefined => {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
};

/**
 * Why this folder can't hold client invoices, or undefined. It holds client data, so it must never
 * be somewhere git would pick it up.
 */
export const archiveDirProblem = (dir: string): string | undefined => {
  const root = repoRootOf(resolve(dir));
  if (!root) return undefined;
  const segments = relative(root, resolve(dir)).split(sep);
  return segments.some((segment) => IGNORED_IN_REPO.includes(segment))
    ? undefined
    : `INVOICE_ARCHIVE_DIR is inside a git repository, where client invoices could be committed. Choose a folder outside it, or one named invoice-archive, which is ignored.`;
};
