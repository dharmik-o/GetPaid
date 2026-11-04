import { formatDateTime, formatSendTime } from "@/lib/format";
import { REPLY_LABEL_NAMES } from "@/lib/reply-labels";
import type { TimelineEntry, TimelineKind } from "@/lib/timeline";

// A client's history, newest first: what was sent, what came back, what was paid, what changed.
// A reply is untrusted text, and React shows it as plain text.

const KINDS: Record<TimelineKind, { name: string; icon: string }> = {
  sent: { name: "Sent", icon: "↗" },
  reply: { name: "Reply", icon: "↙" },
  payment: { name: "Payment", icon: "✓" },
  status: { name: "Update", icon: "•" },
};

type Props = { entries: TimelineEntry[]; clientZone: string; ownZone: string };

const When = ({
  entry,
  clientZone,
  ownZone,
}: { entry: TimelineEntry } & Omit<Props, "entries">) => (
  <time className="muted" dateTime={entry.at.toISOString()}>
    {entry.kind === "sent"
      ? formatSendTime(entry.at, clientZone, ownZone)
      : `${formatDateTime(entry.at, ownZone)} (${ownZone})`}
  </time>
);

const Row = ({ entry, clientZone, ownZone }: { entry: TimelineEntry } & Omit<Props, "entries">) => {
  const kind = KINDS[entry.kind];
  return (
    <li className="timeline-row">
      <span className={`timeline-icon timeline-${entry.kind}`} aria-hidden="true">
        {kind.icon}
      </span>
      <div className="timeline-body">
        <p className="timeline-title">
          <span className="chip">{kind.name}</span>
          <strong>{entry.title}</strong>
          {entry.reference ? <span className="muted"> · {entry.reference}</span> : null}
        </p>
        <When entry={entry} clientZone={clientZone} ownZone={ownZone} />
        {entry.kind === "reply" && entry.body ? (
          <p className="timeline-text">{entry.body}</p>
        ) : null}
        {entry.aiLabel ? (
          <p className="muted">AI suggestion: {REPLY_LABEL_NAMES[entry.aiLabel]}</p>
        ) : null}
        {entry.kind === "sent" && entry.body ? (
          <details>
            <summary>{entry.subject ?? "Show the email"}</summary>
            <p className="timeline-text">{entry.body}</p>
          </details>
        ) : null}
      </div>
    </li>
  );
};

export const Timeline = ({ entries, clientZone, ownZone }: Props) => (
  <section className="card" aria-labelledby="timeline">
    <h2 id="timeline">Timeline</h2>
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
