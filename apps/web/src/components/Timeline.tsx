import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { PaidBadge, PaidMoment } from "@/components/PaidMoment";
import { formatDateTime, formatSendTime } from "@/lib/format";
import { REPLY_LABEL_NAMES } from "@/lib/reply-labels";
import type { TimelineEntry, TimelineKind } from "@/lib/timeline";

// A client's history, newest first: what was sent, what came back, what was paid, what changed.
// A reply is untrusted text, and React shows it as plain text.

const KINDS: Record<TimelineKind, string> = {
  sent: "Email",
  reply: "Client reply",
  payment: "Payment",
  status: "Update",
};

type Props = { entries: TimelineEntry[]; clientZone: string; ownZone: string };

const When = ({
  entry,
  clientZone,
  ownZone,
}: { entry: TimelineEntry } & Omit<Props, "entries">) => (
  <time className="muted timeline-time" dateTime={entry.at.toISOString()}>
    {entry.kind === "sent"
      ? formatSendTime(entry.at, clientZone, ownZone)
      : `${formatDateTime(entry.at, ownZone)} (${ownZone})`}
  </time>
);

/** A full payment or a captured hold gets the stamp. Everything else is a plain row. */
const Body = ({ entry, children }: { entry: TimelineEntry; children: ReactNode }) =>
  entry.stampId ? (
    <PaidMoment
      className="timeline-body"
      stampId={entry.stampId}
      announcement={entry.reference ? `${entry.reference} paid` : entry.title}
    >
      {children}
    </PaidMoment>
  ) : (
    <div className="timeline-body">{children}</div>
  );

const Row = ({ entry, clientZone, ownZone }: { entry: TimelineEntry } & Omit<Props, "entries">) => {
  const aiPanel = entry.kind === "reply" && entry.aiLabel !== null;
  return (
    <li className="timeline-row">
      <span className="timeline-node" aria-hidden="true" />
      <Body entry={entry}>
        <div className="timeline-head">
          <p className="timeline-title">
            <span className={`chip chip-${entry.kind}`}>{KINDS[entry.kind]}</span>
            {entry.stampId ? (
              <>
                <PaidBadge />{" "}
              </>
            ) : null}
            <strong>{entry.title}</strong>
            {entry.reference ? <span className="muted"> · {entry.reference}</span> : null}
          </p>
          <When entry={entry} clientZone={clientZone} ownZone={ownZone} />
        </div>
        {entry.kind === "reply" && entry.body && !aiPanel ? (
          <p className="timeline-text">{entry.body}</p>
        ) : null}
        {entry.aiLabel ? (
          <div className="ai-panel" data-tour="client-ai-suggestion">
            <p className="ai-title">
              <Icon name="sparkle" size={16} />
              AI suggestion: {REPLY_LABEL_NAMES[entry.aiLabel]}
            </p>
            {entry.body ? <p className="ai-quote">{entry.body}</p> : null}
          </div>
        ) : null}
        {entry.kind === "sent" && entry.body ? (
          <details>
            <summary>{entry.subject ?? "Show the email"}</summary>
            <p className="timeline-text">{entry.body}</p>
          </details>
        ) : null}
      </Body>
    </li>
  );
};

export const Timeline = ({ entries, clientZone, ownZone }: Props) => (
  <section className="card" aria-labelledby="timeline" data-tour="client-timeline">
    <div className="card-head">
      <h2 id="timeline">Timeline</h2>
      <span className="meta-label">Activity log</span>
    </div>
    {entries.length === 0 ? (
      <p className="muted">
        Nothing here yet. Emails, replies, payments and status changes for this client appear here
        once you send an invoice.
      </p>
    ) : (
      <ol className="timeline">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} clientZone={clientZone} ownZone={ownZone} />
        ))}
      </ol>
    )}
  </section>
);
