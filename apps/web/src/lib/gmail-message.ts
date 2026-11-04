import type { GmailThreadMessage } from "./gmail";

// Reads what's needed out of a Gmail message: its headers and its text. Everything in here came
// from outside, so it's only ever stored and shown as text. Pure.

export const BODY_MAX = 20_000;

type Part = GmailThreadMessage["payload"];

const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

const findPart = (part: Part, mimeType: string): Part | undefined => {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Text from HTML, for reading and classifying. It's never rendered as HTML. */
const textFromHtml = (html: string): string =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const looksLikeHtml = (text: string): boolean => /<\/?[a-z][^>]*>/i.test(text);

export const messageText = (message: GmailThreadMessage): string => {
  const plain = findPart(message.payload, "text/plain");
  const html = findPart(message.payload, "text/html");
  const text = plain?.body?.data
    ? decode(plain.body.data)
    : html?.body?.data
      ? textFromHtml(decode(html.body.data))
      : "";
  const readable = looksLikeHtml(text) ? textFromHtml(text) : text.trim();
  return readable.slice(0, BODY_MAX);
};

export const messageHeader = (message: GmailThreadMessage, name: string): string | undefined =>
  message.payload.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value;

/** The address in `Name <address>` or a bare address, in lower case. */
export const fromAddress = (message: GmailThreadMessage): string => {
  const from = messageHeader(message, "From") ?? "";
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
};
