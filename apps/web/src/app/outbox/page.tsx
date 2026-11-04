import Link from "next/link";
import { OutboxCard } from "@/components/OutboxCard";
import { OutboxLive } from "@/components/OutboxLive";
import { listOutbox, outboxCounts, OUTBOX_TABS, type OutboxTab } from "@/lib/outbox";
import { runAsCurrentUser } from "@/lib/request-user";

// Outbox: review drafts, approve / edit / skip / reschedule. Nothing leaves without approval.

export const dynamic = "force-dynamic";

const TAB_LABELS: Record<OutboxTab, string> = {
  waiting: "Waiting",
  scheduled: "Scheduled",
  sent: "Sent",
  skipped: "Skipped",
};

const EMPTY: Record<OutboxTab, string> = {
  waiting: "No drafts waiting. Reminders appear here before they're sent.",
  scheduled: "Nothing scheduled. Drafts you approve wait here until their send time.",
  sent: "Nothing sent yet. Sent reminders are listed here.",
  skipped: "Nothing skipped. Drafts you skip, or that a payment stopped, are listed here.",
};

const tabOf = (value: unknown): OutboxTab => OUTBOX_TABS.find((tab) => tab === value) ?? "waiting";

type Props = { searchParams: Promise<{ tab?: string | string[] }> };

const OutboxPage = async ({ searchParams }: Props) => {
  const tab = tabOf((await searchParams).tab);
  const { items, counts } = await runAsCurrentUser(async (db) => ({
    items: await listOutbox(db, tab, new Date()),
    counts: await outboxCounts(db),
  }));
  return (
    <div className="page">
      <OutboxLive />
      <div className="page-header">
        <h1>Outbox</h1>
      </div>
      <nav className="tabs" aria-label="Filter drafts">
        {OUTBOX_TABS.map((name) => (
          <Link
            key={name}
            href={`/outbox?tab=${name}`}
            aria-current={name === tab ? "page" : undefined}
          >
            {TAB_LABELS[name]} ({counts[name]})
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <div className="card empty">
          <p>{EMPTY[tab]}</p>
        </div>
      ) : (
        items.map((item) => <OutboxCard key={item.id} item={item} />)
      )}
    </div>
  );
};

export default OutboxPage;
