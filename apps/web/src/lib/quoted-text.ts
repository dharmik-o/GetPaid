/**
 * Text from outside, made safe to put between a prompt's tags: one line, no separator, and no tag
 * can be opened or closed from inside it. Shared by the calendar and help assistants.
 */
export const safeText = (text: string): string =>
  Array.from(text)
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char))
    .join("")
    .replaceAll("|", "/")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .trim();
