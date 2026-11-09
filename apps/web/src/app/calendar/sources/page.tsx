import Link from "next/link";
import { CalendarSources } from "@/components/CalendarSources";
import { getOwnTimeZone } from "@/lib/account";
import { listSources } from "@/lib/calendar-import";
import { runAsCurrentUser } from "@/lib/request-user";

// Imported calendars: where they come from, when they last synced, and what went wrong if not.

export const dynamic = "force-dynamic";

const SourcesPage = async () => {
  const { sources, zone } = await runAsCurrentUser(async (db) => ({
    sources: await listSources(db),
    zone: await getOwnTimeZone(db),
  }));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Imported calendars</h1>
        <Link href="/calendar">Back to calendar</Link>
      </div>
      <CalendarSources sources={sources} zone={zone} />
    </div>
  );
};

export default SourcesPage;
