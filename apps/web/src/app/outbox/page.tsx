import Link from "next/link";
import { AnimatedList } from "@/components/AnimatedList";
import { OutboxCard } from "@/components/OutboxCard";
import { OutboxLive } from "@/components/OutboxLive";
import { HeldInvoiceRow } from "@/components/HeldInvoiceRow";
import { ReplyCard, type SplitOffer } from "@/components/ReplyCard";
import { appNow } from "@/lib/clock";
import { getGmailAccount } from "@/lib/gmail-account";
import { splitOffer } from "@/lib/invoice-split";
import {
  listHeldInvoices,
  listPendingReplies,
  type HeldInvoice,
  type ReplyItem,
} from "@/lib/reply-review";
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
  const now = appNow();
  const { items, counts, replies, held, gmail } = await runAsCurrentUser(async (db) => {
    const pending = await listPendingReplies(db, now);
    const withOffers: { reply: ReplyItem; offer: SplitOffer | null }[] = [];
    for (const reply of pending) {
      withOffers.push({
        reply,
        offer: reply.milestoneId
          ? ((await splitOffer(db, reply.milestoneId, reply.today, reply.splitLastDate)) ?? null)
          : null,
      });
    }
    return {
      items: await listOutbox(db, tab, now),
      counts: await outboxCounts(db),
      replies: withOffers,
      held: await listHeldInvoices(db, now),
      gmail: await getGmailAccount(db),
    };
  });
  return (
    <div className="page">
      <OutboxLive />
      <div className="page-header">
        <h1>Outbox</h1>
      </div>
      {gmail.status === "needs_reconnect" ? (
        <p className="banner banner-warning" role="alert">
          Google ended the Gmail connection, so approved reminders are held, not lost.{" "}
          <Link href="/settings/integrations">Reconnect Gmail</Link> and they go out.
        </p>
      ) : null}
      {replies.length > 0 ? (
        <section aria-labelledby="outbox-replies">
          <h2 id="outbox-replies">Replies to review ({replies.length})</h2>
          <AnimatedList>
            {replies.map(({ reply, offer }) => (
              <ReplyCard key={reply.id} reply={reply} offer={offer} />
            ))}
          </AnimatedList>
        </section>
      ) : null}
      {held.length > 0 ? (
        <section aria-labelledby="outbox-held">
          <h2 id="outbox-held">Reminders on hold ({held.length})</h2>
          <AnimatedList>
            {held.map((invoice: HeldInvoice) => (
              <HeldInvoiceRow key={invoice.id} invoice={invoice} />
            ))}
          </AnimatedList>
        </section>
      ) : null}
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
        <AnimatedList key={tab}>
          {items.map((item) => (
            <OutboxCard key={item.id} item={item} />
          ))}
        </AnimatedList>
      )}
    </div>
  );
};

export default OutboxPage;
