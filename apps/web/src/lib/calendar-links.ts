import type { CalendarItem } from "./calendar-feed";
import { compactInstant } from "./ics";
import { addCalendarDays } from "./schedule";

// Pure: "Add to Google Calendar" and "Add to Outlook" links for one item. They put the item's title,
// dates, client name and (for the freelancer's own entries) notes into a web address the freelancer
// opens themselves. Every value is URL-encoded.

type Linkable = Pick<
  CalendarItem,
  "title" | "startsOn" | "endsOn" | "startAt" | "endAt" | "clientName" | "notes"
>;

const HOUR_MS = 60 * 60 * 1000;

const details = (item: Linkable): string =>
  [item.clientName ? `Client: ${item.clientName}` : null, item.notes]
    .filter((part): part is string => part !== null && part !== "")
    .join("\n");

/** The end of a timed item, or an hour after its start when it has none (these links need one). */
const endOf = (item: Linkable & { startAt: string }): string =>
  item.endAt ?? new Date(new Date(item.startAt).getTime() + HOUR_MS).toISOString();

const query = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

/** Google's "create event" template: dates are yyyymmdd (end day not included) or yyyymmddThhmmssZ. */
export const googleCalendarLink = (item: Linkable): string => {
  const dates =
    item.startAt === null
      ? `${item.startsOn.replaceAll("-", "")}/${addCalendarDays(item.endsOn ?? item.startsOn, 1).replaceAll("-", "")}`
      : `${compactInstant(item.startAt)}/${compactInstant(endOf({ ...item, startAt: item.startAt }))}`;
  return `https://calendar.google.com/calendar/render?${query({
    action: "TEMPLATE",
    text: item.title,
    dates,
    details: details(item),
  })}`;
};

/**
 * Outlook on the web's compose link. Microsoft Learn has no reference page for it; the parameter names
 * (path, rru, subject, startdt, enddt, allday, body) are the ones Microsoft staff and users give in
 * https://learn.microsoft.com/en-us/answers/questions/4730856/ and neighbouring Q&A threads, with times
 * in UTC because the link has no reliable time zone parameter. Unverified against an official page:
 * see docs/NEEDS_YOU.md.
 */
export const outlookCalendarLink = (item: Linkable): string => {
  const when =
    item.startAt === null
      ? {
          startdt: item.startsOn,
          enddt: addCalendarDays(item.endsOn ?? item.startsOn, 1),
          allday: "true",
        }
      : {
          startdt: new Date(item.startAt).toISOString(),
          enddt: new Date(endOf({ ...item, startAt: item.startAt })).toISOString(),
          allday: "false",
        };
  return `https://outlook.office.com/calendar/deeplink/compose?${query({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: item.title,
    ...when,
    body: details(item),
  })}`;
};
