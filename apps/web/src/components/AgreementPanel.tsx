import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { AgreementSummary } from "@/lib/agreements";
import { formatDay } from "@/lib/format";

// The Agreement section of the Project page: every version and where it stands.

const LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent, waiting for the client",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  void: "Voided",
};

export const AgreementPanel = ({
  projectId,
  agreements,
}: {
  projectId: string;
  agreements: AgreementSummary[];
}) => (
  <>
    {agreements.length === 0 ? (
      <p className="muted">
        No agreement yet. Build one from this project&apos;s milestones and terms.
      </p>
    ) : (
      <ul>
        {agreements.map((a) => (
          <li key={a.id}>
            {a.number} version {a.version}{" "}
            <StatusBadge status={a.status}>{LABELS[a.status] ?? a.status}</StatusBadge>{" "}
            <span className="muted">{formatDay(a.createdAt.slice(0, 10))}</span>
          </li>
        ))}
      </ul>
    )}
    <Link className="button button-secondary" href={`/projects/${projectId}/agreement`}>
      {agreements.length === 0 ? "Create agreement" : "Open agreement"}
    </Link>
  </>
);
