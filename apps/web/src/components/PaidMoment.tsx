"use client";

import { motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { claimPaidStamp } from "@/lib/paid-stamps";

// The app's small reward: the GetPaid stamp drops onto a row the first time this browser sees it paid.
// The animation runs only after the page loads, so it never changes what the server rendered.

const STAMP_SECONDS = 0.45;
const FROM = { scale: 2.8, rotate: -50, opacity: 0 };
const REST = { scale: 1, rotate: -14, opacity: 1 };
const BOUNCE_PX = 4;

const Playing = createContext(false);

type Props = {
  /** See lib/paid-stamps.ts. The same item keeps one ID on every page. */
  stampId: string;
  /** What a screen reader hears, such as "FPR-000042 paid". */
  announcement: string;
  /** Rows that aren't paid yet stay still, and start once they are. */
  paid?: boolean;
  className?: string;
  children: ReactNode;
};

export const PaidMoment = ({ stampId, announcement, paid = true, className, children }: Props) => {
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (paid && claimPaidStamp(stampId)) setPlaying(true);
  }, [paid, stampId]);
  return (
    <Playing.Provider value={playing}>
      <motion.div
        className={className ? `paid-moment ${className}` : "paid-moment"}
        animate={playing && !reduced ? { y: [0, BOUNCE_PX, 0] } : undefined}
        transition={{ delay: STAMP_SECONDS, duration: 0.25 }}
      >
        {children}
        {playing ? (
          <motion.span
            className="paid-stamp"
            aria-hidden="true"
            initial={reduced ? false : FROM}
            animate={REST}
            transition={{ duration: STAMP_SECONDS, ease: "easeIn" }}
          />
        ) : null}
        {paid ? (
          <span className="visually-hidden" role="status" aria-live="polite">
            {playing ? announcement : ""}
          </span>
        ) : null}
      </motion.div>
    </Playing.Provider>
  );
};

/** The Paid badge. Inside a playing PaidMoment, it pops as the stamp lands. */
export const PaidBadge = ({ children = "Paid" }: { children?: ReactNode }) => {
  const playing = useContext(Playing);
  const reduced = useReducedMotion();
  if (!playing || reduced) return <span className="badge badge-paid">{children}</span>;
  return (
    <motion.span
      className="badge badge-paid"
      initial={{ scale: 0.6 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 28, delay: STAMP_SECONDS }}
    >
      {children}
    </motion.span>
  );
};
