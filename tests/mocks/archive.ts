import type { PdfFile } from "@/lib/invoice-pdfs";

// For sender tests that aren't about the archive: a PDF with its facts, and an archive that keeps
// nothing. tests/api/invoice-archive.test.ts runs the real one on a real folder.

export const NO_ARCHIVE = {
  stage: () => Promise.resolve("no-file"),
  markSent: () => Promise.resolve(),
};

export const fakePdfFile = (pdf: Buffer, filename: string): PdfFile => ({
  pdf,
  filename,
  sourceSha256: "0".repeat(64),
  templateName: "Classic",
  signed: false,
});
