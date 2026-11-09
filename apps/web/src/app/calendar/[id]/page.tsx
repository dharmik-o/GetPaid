import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarEntryForm } from "@/components/CalendarEntryForm";
import { getEntry } from "@/lib/calendar-entries";
import { linkValueOf, loadLinkOptions } from "@/lib/calendar-link-options";
import { isUuid } from "@/lib/db";
import { runAsCurrentUser } from "@/lib/request-user";

// One calendar entry: change it, mark it done, or delete it.

export const dynamic = "force-dynamic";

const EntryPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { entry, links } = await runAsCurrentUser(async (db) => ({
    entry: await getEntry(db, id),
    links: await loadLinkOptions(db),
  }));
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
    </div>
  );
};

export default EntryPage;
