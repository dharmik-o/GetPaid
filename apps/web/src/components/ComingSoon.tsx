import Link from "next/link";
import type { ReactNode } from "react";

// A screen whose feature isn't built yet: says what it will do and in which milestone, and
// points to what works today. Server component.

type Props = {
  title: string;
  what: string;
  milestone: string;
  children?: ReactNode;
};

export const ComingSoon = ({ title, what, milestone, children }: Props) => (
  <div className="page">
    <div className="page-header">
      <h1>{title}</h1>
    </div>
    <div className="card empty">
      <p>{what}</p>
      <p className="muted">Not built yet: this arrives in {milestone} (docs/FEATURES.md).</p>
      {children ?? (
        <Link className="button" href="/clients">
          Go to clients
        </Link>
      )}
    </div>
  </div>
);
