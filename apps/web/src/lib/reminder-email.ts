import { randomBytes } from "node:crypto";
import type { PdfFile } from "./invoice-pdfs";

// Server-only: the email a reminder goes out as (the M7 sender passes it to Gmail as `raw`).
// Plain text, on the original thread, with the invoice PDF attached: the PDF is a required
// argument, so a reminder can't be built without saying what's attached. Only an email with no
// invoice behind it (a maintenance heads-up, an auto-pay approval) passes null. Header values can't carry a line break, so a
// subject or name can't add headers.

export type ReminderEmail = {
  from: { name: string; email: string };
  to: { name: string; email: string };
  subject: string;
  body: string;
  /** The invoice document; null only for an email with no invoice behind it. */
  pdf: Pick<PdfFile, "pdf" | "filename"> | null;
  /** The Message-ID of the thread's first email, to stay on the original thread. */
  inReplyTo?: string | null;
  /** The thread's Message-IDs, oldest first. The latest is the one this replies to. */
  references?: readonly string[];
  /** This email's own Message-ID. */
  messageId?: string;
};

const LINE = 76;

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047: non-ASCII header text as UTF-8 base64. */
const encodeWord = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const address = ({ name, email }: { name: string; email: string }): string => {
  const cleanEmail = oneLine(email).replace(/[<>"\s,]/g, "");
  const cleanName = oneLine(name).replace(/["\\]/g, "");
  return cleanName ? `"${encodeWord(cleanName)}" <${cleanEmail}>` : `<${cleanEmail}>`;
};

const base64Lines = (data: Buffer): string =>
  (data.toString("base64").match(new RegExp(`.{1,${String(LINE)}}`, "g")) ?? []).join("\r\n");

const messageId = (value: string): string => `<${oneLine(value).replace(/[<>\s]/g, "")}>`;

const attachmentLines = (
  pdf: Pick<PdfFile, "pdf" | "filename"> | null,
  boundary: string,
): string[] => {
  if (!pdf) return [];
  const filename = pdf.filename.replace(/[^A-Za-z0-9._-]/g, "");
  return [
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(pdf.pdf),
  ];
};

export const buildReminderEmail = (email: ReminderEmail): string => {
  const boundary = `fpr-${randomBytes(12).toString("hex")}`;
  const chain = email.references ?? (email.inReplyTo ? [email.inReplyTo] : []);
  const latest = chain.at(-1);
  const thread = latest
    ? [`In-Reply-To: ${messageId(latest)}`, `References: ${chain.map(messageId).join("\r\n ")}`]
    : [];
  const own = email.messageId ? [`Message-ID: ${messageId(email.messageId)}`] : [];
  return [
    `From: ${address(email.from)}`,
    `To: ${address(email.to)}`,
    `Subject: ${encodeWord(oneLine(email.subject))}`,
    ...own,
    ...thread,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(email.body, "utf8")),
    ...attachmentLines(email.pdf, boundary),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

/** What the Gmail API's messages.send takes as `raw`. */
export const toGmailRaw = (mime: string): string => Buffer.from(mime, "utf8").toString("base64url");
