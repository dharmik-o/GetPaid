"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

type Item = { href: string; label: string };

type Props = {
  items: Item[];
  isCurrent: (href: string) => boolean;
};

const SPRING = { type: "spring", stiffness: 420, damping: 28 } as const;

/** The bottom bar's More: everything that doesn't fit on a phone's bar, one tap away. */
export const MoreMenu = ({ items, isCurrent }: Props) => {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="more-box" ref={box}>
      <button
        type="button"
        ref={button}
        className={
          items.some(({ href }) => isCurrent(href)) ? "more-button is-current" : "more-button"
        }
        aria-expanded={open}
        aria-controls="more-menu"
        onClick={() => {
          setOpen((now) => !now);
        }}
      >
        <span className="nav-icon">
          <Icon name="more" />
        </span>
        More
      </button>
      <AnimatePresence>
        {open ? (
          <motion.ul
            id="more-menu"
            className="more-menu"
            initial={reduced ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={
              reduced
                ? { opacity: 1, transition: { duration: 0 } }
                : { opacity: 0, y: 24, transition: { duration: 0.18 } }
            }
            transition={SPRING}
          >
            {items.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={isCurrent(href) ? "page" : undefined}
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {label}
                </Link>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
};
