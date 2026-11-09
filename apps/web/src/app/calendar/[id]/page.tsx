import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarEntryForm } from "@/components/CalendarEntryForm";
import { getEntry } from "@/lib/calendar-entries";
import { calendarItems } from "@/lib/calendar-feed";
import { googleCalendarLink, outlookCalendarLink } from "@/lib/calendar-links";
import { linkValueOf, loadLinkOptions } from "@/lib/calendar-link-options";
import { getOwnTimeZone } from "@/lib/account";
import { isUuid } from "@/lib/db";
import { addCalendarDays } from "@/lib/schedule";
import { runAsCurrentUser } from "@/lib/request-user";

// One calendar entry: change it, mark it done, or delete it.

export const dynamic = "force-dynamic";

const EntryPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { entry, links, item } = await runAsCurrentUser(async (db) => {
    const found = await getEntry(db, id);
    if (!found) return { entry: null, links: [], item: undefined };
    // The feed gives the entry's dates as the viewer sees them, which the calendar links need.
    const near = await calendarItems(db, {
      from: addCalendarDays(found.startsOn, -1),
      to: addCalendarDays(found.endsOn ?? found.startsOn, 1),
      zone: await getOwnTimeZone(db),
    });
    return {
      entry: found,
      links: await loadLinkOptions(db),
      item: near.find((candidate) => candidate.key === `entry:${id}`),
    };
  });
  if (!entry) notFound();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Calendar entry</h1>
        <Link href="/calendar">Back to calendar</Link>
      </div>
      <CalendarEntryForm
        links={links}
        initial={{
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          startsOn: entry.startsOn,
          endsOn: entry.endsOn ?? "",
          startTime: entry.startTime ?? "",
          endTime: entry.endTime ?? "",
          link: linkValueOf(entry),
          notes: entry.notes ?? "",
          remindOnDay: entry.remindOnDay,
          done: entry.status === "done",
        }}
      />
      {item ? (
        <section className="card" aria-label="Add to another calendar">
          <h2>Add to another calendar</h2>
          <div className="actions">
            <a
              className="button button-secondary"
              href={googleCalendarLink(item)}
              target="_blank"
              rel="noreferrer"
            >
              Add to Google Calendar
            </a>
            <a
              className="button button-secondary"
              href={outlookCalendarLink(item)}
              target="_blank"
              rel="noreferrer"
            >
              Add to Outlook
            </a>
          </div>
        </section>
      ) : null}
    </div>
  );
};

export default EntryPage;
