// A rubber-stamp look for a settled or late payment: a tilted, dashed rectangle in the heading
// font. It's decoration: the badge beside it says the status in words, so this is aria-hidden.

export type StampKind = "paid" | "part" | "overdue";

const WORDS: Record<StampKind, string> = {
  paid: "PAID",
  part: "PART PAID",
  overdue: "OVERDUE",
};

/** The stamp for a milestone or invoice status, or null when it has none (sent, draft, planned). */
export const stampFor = (status: string): StampKind | null =>
  status === "paid"
    ? "paid"
    : status === "partially_paid"
      ? "part"
      : status === "overdue"
        ? "overdue"
        : null;

export const StatusStamp = ({ kind }: { kind: StampKind }) => (
  <span className={`status-stamp status-stamp-${kind}`} aria-hidden="true">
    {WORDS[kind]}
  </span>
);
