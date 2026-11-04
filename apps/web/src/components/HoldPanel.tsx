"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import type { HoldView } from "@/lib/milestone-holds";
import { statusLabel, type MilestoneStatus } from "@/lib/milestone-status";

// Milestone holds on a project: the client authorizes at the start, it's captured when you mark the
// milestone Accepted, and voiding releases the money. Nothing here reaches the client by itself.

export type HoldRowData = {
  milestoneId: string;
  name: string;
  cents: number;
  status: MilestoneStatus;
  /** The deadline is more than 29 days away. */
  deadlineTooFar: boolean;
  hold: HoldView | null;
};

const EMAIL_TEXT: Record<HoldView["approvalEmail"], string> = {
  none: "The email asking the client to authorize was skipped. Void this hold and start again to send another.",
  waiting: "The email asking the client to authorize is waiting for you in the Outbox.",
  scheduled:
    "The email asking the client to authorize is approved, and goes out in their send window.",
  sent: "The client has been emailed the link. This changes once they authorize it.",
};

const stateText = (row: HoldRowData): string => {
  const { hold } = row;
  if (!hold) return "No hold yet. Start one at the beginning of the milestone.";
  switch (hold.status) {
    case "creating":
      return "The hold didn't finish setting up in PayPal. Start it again to carry on.";
    case "pending_approval":
      return EMAIL_TEXT[hold.approvalEmail];
    case "authorized":
      return hold.captureFailed
        ? "PayPal didn't capture this. The hold is still in place, and this tries again each hour."
        : `Authorized: the money is on hold. It's captured when you mark this milestone Accepted${
            hold.pastHonor ? ", after a fresh authorization, as it's past day 3" : ""
          }.`;
    case "capturing":
      return "PayPal is finishing the capture.";
    case "captured":
      return "Captured: the money is in.";
    case "voided":
      return "Voided: the money was released, and nothing was taken.";
    case "expired":
      return "Expired after 29 days, and nothing was taken.";
    case "failed":
      return "PayPal denied the capture, and nothing was taken.";
  }
};

const canStart = ({ hold, status }: HoldRowData): boolean =>
  (status === "planned" || status === "in_progress") &&
  (!hold || !["pending_approval", "authorized", "capturing", "captured"].includes(hold.status));

const canVoid = ({ hold }: HoldRowData): boolean =>
  hold !== null && ["pending_approval", "authorized"].includes(hold.status);

const canCapture = ({ hold, status }: HoldRowData): boolean =>
  status === "accepted" && hold?.status === "authorized";

export const HoldPanel = ({ rows, currency }: { rows: HoldRowData[]; currency: string }) => {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const act = async (row: HoldRowData, action: "start" | "capture" | "void", done: string) => {
    setBusy(row.milestoneId);
    setMessage(undefined);
    const result = await sendJson(
      `/api/milestones/${row.milestoneId}/hold`,
      "POST",
      { action },
      {},
    );
    setBusy(undefined);
    setMessage(result.ok ? { text: done, error: false } : { text: result.message, error: true });
    if (result.ok) router.refresh();
  };

  return (
    <>
      {rows.map((row) => (
        <article key={row.milestoneId} aria-label={`Hold for ${row.name}`}>
          <h3>
            {row.name} · {formatMoney(row.cents, currency)}
          </h3>
          <p className="muted">Milestone: {statusLabel(row.status)}</p>
          <p>{stateText(row)}</p>
          {row.deadlineTooFar && canStart(row) ? (
            <p className="banner banner-warning" role="status">
              This milestone&apos;s deadline is more than 29 days away, and PayPal holds money for
              29 days at most. The hold could expire before the work is accepted.
            </p>
          ) : null}
          <div className="actions">
            {canStart(row) ? (
              <button
                className="button"
                type="button"
                disabled={busy !== undefined}
                onClick={() =>
                  void act(row, "start", "Draft made. Review it in the Outbox before it goes.")
                }
              >
                Start hold
              </button>
            ) : null}
            {canCapture(row) ? (
              <button
                className="button"
                type="button"
                disabled={busy !== undefined}
                onClick={() => void act(row, "capture", "Done.")}
              >
                Try the capture again
              </button>
            ) : null}
            {canVoid(row) ? (
              <button
                className="button button-secondary"
                type="button"
                disabled={busy !== undefined}
                onClick={() => void act(row, "void", "Voided. The money is released.")}
              >
                Void hold
              </button>
            ) : null}
          </div>
        </article>
      ))}
      {message ? (
        <p
          className={message.error ? "banner banner-error" : "banner"}
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </>
  );
};
