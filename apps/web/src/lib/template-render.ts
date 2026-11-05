import Mustache from "mustache";
import { documentFontCss } from "./document-fonts";
import { checkTemplateTags, type TagIssue } from "./template-tags";

// Fills a sanitised template with the invoice's values and wraps it in a full document. Every
// value is HTML-escaped (Mustache's {{ }}); unescaped tags never pass checkTemplateTags. The
// Content-Security-Policy is a second lock: the preview iframe and the PDF renderer may load
// nothing but embedded images and the inline CSS.

export class TemplateTagError extends Error {
  constructor(readonly issues: TagIssue[]) {
    super(`The template has ${String(issues.length)} tag problem(s). Fix them in the editor.`);
  }
}

export const DOCUMENT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

export type TemplateSource = { html: string; css: string };

/** The full HTML document for one invoice. Throws TemplateTagError on an unknown tag. */
export const renderInvoiceHtml = (
  template: TemplateSource,
  view: Record<string, unknown>,
): string => {
  const issues = checkTemplateTags(template.html);
  if (issues.length > 0) throw new TemplateTagError(issues);
  const body = Mustache.render(template.html, view, {}, { escape: Mustache.escape });
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">`,
    `<style>${documentFontCss(template.css)}${template.css}</style>`,
    `</head><body>${body}</body></html>`,
  ].join("");
};
