import { createHash } from "node:crypto";
import type { StoredDraft } from "./stored-draft";

// The two emails an agreement sends, as fixed text: no AI writes them, and no model is asked.
// Pure. The request carries the signing link as its one link; the signed copy carries none (the
// PDF is attached).

const TOKEN_IN_LINK = /\/sign\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;
const ANY_LINK = /https?:\/\/[^\s)>"']+/gi;

export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const base = (
  kind: StoredDraft["kind"],
  subject: string,
  body: string,
  now: Date,
): StoredDraft => ({
  subject,
  body,
  kind,
  via: "template",
  model: null,
  isLocal: null,
  citation: null,
  lawId: null,
  notLegalAdvice: false,
  draftedAt: now.toISOString(),
});

export const requestDraft = (
  facts: { clientName: string; projectTitle: string; freelancerName: string; link: string },
  now: Date,
): StoredDraft =>
  base(
    "agreement_request",
    `Agreement to sign: ${facts.projectTitle}`,
    [
      `Hi ${facts.clientName},`,
      "",
      `Here is the agreement for "${facts.projectTitle}". Please read it and, if you agree, sign it online:`,
      "",
      facts.link,
      "",
      "The link works for 30 days. You sign by typing your full name. If anything needs changing, reply to this email and I'll update it.",
      "",
      "Thanks,",
      facts.freelancerName,
    ].join("\n"),
    now,
  );

export const signedCopyDraft = (
  facts: { clientName: string; projectTitle: string; freelancerName: string },
  now: Date,
): StoredDraft =>
  base(
    "agreement_signed_copy",
    `Signed agreement: ${facts.projectTitle}`,
    [
      `Hi ${facts.clientName},`,
      "",
      `Thank you for signing the agreement for "${facts.projectTitle}". A copy of the signed agreement, with the record of when and how it was signed, is attached.`,
      "",
      "Thanks,",
      facts.freelancerName,
    ].join("\n"),
    now,
  );

/**
 * Why a request email may not go out, or undefined. The one link in it must be this agreement's
 * signing link: its token's hash must match the stored hash, and there must be no other link.
 * The token itself is stored nowhere but in this email.
 */
export const signingLinkProblem = (
  body: string,
  tokenSha256: string | null,
): string | undefined => {
  const links = body.match(ANY_LINK) ?? [];
  const token = links.length === 1 ? TOKEN_IN_LINK.exec(links[0])?.[1] : undefined;
  if (token && tokenSha256 !== null && sha256Hex(token) === tokenSha256) return undefined;
  return "it must carry this agreement's signing link, and no other link";
};
