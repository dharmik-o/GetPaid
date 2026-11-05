"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Children, isValidElement, type ReactNode } from "react";

const ENTER = [0.22, 1, 0.36, 1] as const;

/**
 * A list where a new item opens up and a removed one collapses. What's already there on load doesn't
 * animate, so a page never moves as it opens. Each child needs its own key.
 */
export const AnimatedList = ({ children }: { children: ReactNode }) => {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {Children.toArray(children).map((child) => (
        <motion.div
          key={isValidElement(child) ? child.key : undefined}
          className="list-item"
          initial={reduced ? false : { height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0 } }
              : { height: 0, opacity: 0, overflow: "hidden", transition: { duration: 0.18 } }
          }
          transition={{ duration: 0.3, ease: ENTER }}
        >
          {child}
        </motion.div>
      ))}
    </AnimatePresence>
  );
};
