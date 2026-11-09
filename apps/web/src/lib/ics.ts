import type { CalendarItem } from "./calendar-feed";
import { addCalendarDays } from "./schedule";

// Pure: our calendar items as an iCalendar (RFC 5545) file, written by hand. Imported events are never
// exported: that would hand someone else's calendar to a third party. No emails, pay links or amounts
// go in beyond what an item's title already says.

const LINE_OCTETS = 75;
const CRLF = "\r\n";

/** Control characters other than tab, LF and CR (those two are handled as line breaks). */
const isStrippedControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
};

/** Text values: a stray line break can't start a new property (that would be injection). */
export const escapeIcsText = (text: string): string =>
  Array.from(text)
    .filter((char) => !isStrippedControl(char))
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/** Lines over 75 octets (UTF-8 bytes) are folded; a continuation starts with one space. Never splits a character. */
export const foldIcsLine = (line: string): string => {
  const lines: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (octets + size > LINE_OCTETS) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(CRLF);
};

const compactDate = (isoDate: string): string => isoDate.replaceAll("-", "");

/** 2026-12-02T14:30:00.000Z becomes 20261202T143000Z. */
export const compactInstant = (iso: string): string =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export type IcsOptions = {
  /** Include the notes of the freelancer's own entries. Off unless asked for. */
  notes: boolean;
  now: Date;
  /** The app's public address, when it is set; items then link back to it. */
  appUrl: string | undefined;
};

const eventLines = (item: CalendarItem, { notes, now, appUrl }: IcsOptions): string[] => {
  const description = [
    item.clientName ? `Client: ${item.clientName}` : null,
    notes ? item.notes : null,
  ].filter((part): part is string => part !== null && part !== "");
  const when =
    item.startAt === null
      ? [
          `DTSTART;VALUE=DATE:${compactDate(item.startsOn)}`,
          `DTEND;VALUE=DATE:${compactDate(addCalendarDays(item.endsOn ?? item.startsOn, 1))}`,
        ]
      : [
          `DTSTART:${compactInstant(item.startAt)}`,
          ...(item.endAt === null ? [] : [`DTEND:${compactInstant(item.endAt)}`]),
        ];
  return [
    "BEGIN:VEVENT",
    `UID:${item.key.replaceAll(":", "-")}@getpaid.local`,
    `DTSTAMP:${compactInstant(now.toISOString())}`,
    ...when,
    `SUMMARY:${escapeIcsText(item.title)}`,
    ...(description.length > 0 ? [`DESCRIPTION:${escapeIcsText(description.join("\n"))}`] : []),
    ...(appUrl ? [`URL:${appUrl}${item.href}`] : []),
    "END:VEVENT",
  ];
};

export const toIcs = (items: readonly CalendarItem[], options: IcsOptions): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GetPaid//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:GetPaid",
    ...items
      .filter((item) => item.type !== "imported")
      .flatMap((item) => eventLines(item, options)),
    "END:VCALENDAR",
  ]
    .map(foldIcsLine)
    .join(CRLF)
    .concat(CRLF);
