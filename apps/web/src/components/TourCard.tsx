"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { placeCard, type Box, type Size } from "@/lib/tour-placement";
import type { TourStep } from "@/lib/tour-steps";

// One step of the tour: a dimmed page with a cut-out round the target, a 2px ring, and a card
// beside it (a bottom sheet on phones). No target on the page: the card shows centred.

const PHONE_WIDTH = 760;
const FIND_TRIES = 20;
const FIND_EVERY_MS = 100;
const PAD = 6;

type Props = {
  step: TourStep;
  index: number;
  total: number;
  /** "tour" for the main walkthrough, "tips" for a page's tips: it only changes the skip label. */
  kind: "tour" | "tips";
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
};

const visible = (el: Element): boolean => {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const findTarget = (name: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)).find(visible) ?? null;

const inFixed = (el: HTMLElement): boolean => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).position === "fixed") return true;
  }
  return false;
};

const toBox = (rect: DOMRect): Box => ({
  top: rect.top,
  left: rect.left,
  width: rect.width,
  height: rect.height,
});

/** Brings the target into view: on a phone to the top part, above the sheet. No smooth scrolling. */
const bringIntoView = (el: HTMLElement): void => {
  if (inFixed(el)) return;
  const rect = el.getBoundingClientRect();
  if (window.innerWidth < PHONE_WIDTH) {
    if (rect.top < 72 || rect.bottom > window.innerHeight * 0.55) {
      window.scrollBy({ top: rect.top - 96, behavior: "auto" });
    }
  } else if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "auto" });
  }
};

/** The target's box on screen, kept up to date; null while looking, "missing" once given up. */
const useTargetBox = (name: string | undefined): Box | null | "missing" => {
  const [box, setBox] = useState<Box | null | "missing">(name ? null : "missing");
  useEffect(() => {
    if (!name) {
      setBox("missing");
      return undefined;
    }
    setBox(null);
    let el: HTMLElement | null = null;
    let tries = 0;
    const measure = () => {
      if (el?.isConnected) setBox(toBox(el.getBoundingClientRect()));
    };
    const settle = setTimeout(measure, 400);
    const look = setInterval(() => {
      el = findTarget(name);
      tries += 1;
      if (el) {
        clearInterval(look);
        bringIntoView(el);
        measure();
      } else if (tries >= FIND_TRIES) {
        clearInterval(look);
        setBox("missing");
      }
    }, FIND_EVERY_MS);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearInterval(look);
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [name]);
  return box;
};

export const TourCard = ({ step, index, total, kind, onBack, onNext, onSkip }: Props) => {
  const reduced = useReducedMotion();
  const box = useTargetBox(step.target);
  const card = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const last = index === total - 1;
  const stepKey = `${kind}-${step.title}`;

  useLayoutEffect(() => {
    const el = card.current;
    if (el) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [stepKey, box]);

  // Focus moves into the card on every step, so a keyboard or screen reader user follows along.
  const ready = box !== null;
  useEffect(() => {
    if (ready) card.current?.focus({ preventScroll: true });
  }, [stepKey, ready]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
        return;
      }
      if (event.key !== "Tab" || !card.current) return;
      const stops = Array.from(card.current.querySelectorAll<HTMLElement>("button"));
      const first = stops[0];
      const end = stops.at(-1);
      if (!first || !end) return;
      const now = document.activeElement;
      if (event.shiftKey && (now === first || now === card.current)) {
        event.preventDefault();
        end.focus();
      } else if (!event.shiftKey && now === end) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onSkip]);

  if (box === null) return <div className="tour-shield tour-dim" aria-hidden="true" />;

  const view = { width: window.innerWidth, height: window.innerHeight };
  const phone = view.width < PHONE_WIDTH;
  const found = box !== "missing";
  const sheetOnTop = found && box.top + box.height / 2 > view.height * 0.55;
  let className = "tour-card";
  let style: CSSProperties = {};
  if (phone && found) {
    className += sheetOnTop ? " tour-sheet tour-sheet-top" : " tour-sheet";
  } else if (found && size) {
    style = placeCard(box, size, view);
  } else if (found) {
    style = { top: 0, left: 0, visibility: "hidden" };
  }

  const cardEl = (
    <motion.div
      ref={card}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      tabIndex={-1}
      className={className}
      style={style}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="tour-top">
        <span className="tour-count">
          {index + 1} of {total}
        </span>
        <button type="button" className="tour-skip" onClick={onSkip}>
          {kind === "tour" ? "Skip tour" : "Skip tips"}
        </button>
      </div>
      <h2 id="tour-title">{step.title}</h2>
      <p>{step.body}</p>
      <div className="tour-actions">
        {index > 0 ? (
          <button type="button" className="button button-secondary" onClick={onBack}>
            Back
          </button>
        ) : null}
        <button type="button" className="button" onClick={onNext}>
          {last ? "Finish" : "Got it"}
        </button>
      </div>
    </motion.div>
  );

  return (
    <>
      <div className={found ? "tour-shield" : "tour-shield tour-dim"} aria-hidden="true" />
      {found ? (
        <div
          className="tour-ring"
          aria-hidden="true"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + 2 * PAD,
            height: box.height + 2 * PAD,
          }}
        />
      ) : null}
      {found ? cardEl : <div className="tour-center">{cardEl}</div>}
      <div role="status" aria-live="polite" className="visually-hidden">
        {`Step ${String(index + 1)} of ${String(total)}: ${step.title}. ${step.body}`}
      </div>
    </>
  );
};
