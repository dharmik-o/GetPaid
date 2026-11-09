import Link from "next/link";
import { CalendarEntryForm } from "@/components/CalendarEntryForm";
import { getOwnTimeZone } from "@/lib/account";
import { loadLinkOptions } from "@/lib/calendar-link-options";
import { appNow } from "@/lib/clock";
import { runAsCurrentUser } from "@/lib/request-user";
import { todayIn } from "@/lib/schedule";

// Add a calendar entry. The query can pre-fill it (for example from a milestone's "Add to
// calendar"); the server checks everything again when it's saved.

export const dynamic = "force-dynamic";

type Search = { date?: string; title?: string; link?: string };

const NewEntryPage = async ({ searchParams }: { searchParams: Promise<Search> }) => {
  const query = await searchParams;
  const { links, today } = await runAsCurrentUser(async (db) => ({
    links: await loadLinkOptions(db),
    today: todayIn(appNow(), await getOwnTimeZone(db)),
  }));
  const link = links.some((option) => option.value === query.link) ? (query.link ?? "") : "";
  return (
    <div className="page">
      <div className="page-header">
        <h1>Add calendar entry</h1>
        <Link href="/calendar">Back to calendar</Link>
      </div>
      <CalendarEntryForm
        links={links}
        initial={{
          title: (query.title ?? "").slice(0, 200),
          kind: "task",
          startsOn: /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? "") ? (query.date ?? today) : today,
          endsOn: "",
          startTime: "",
          endTime: "",
          link,
          notes: "",
          remindOnDay: false,
        }}
      />
    </div>
  );
};

export default NewEntryPage;
