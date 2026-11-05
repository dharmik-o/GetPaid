"use client";

import { useEffect, useState } from "react";

// Copies a value, then says so for 2 seconds. If the browser won't allow it, it says that instead.

const SHOWN_MS = 2000;

type State = "idle" | "copied" | "failed";

const LABELS: Record<State, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Couldn't copy",
};

export const CopyButton = ({ value, label }: { value: string; label: string }) => {
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = setTimeout(() => {
      setState("idle");
    }, SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <button
      type="button"
      className="button button-secondary"
      aria-label={state === "idle" ? label : LABELS[state]}
      onClick={() => {
        void copy();
      }}
    >
      <span aria-live="polite">{LABELS[state]}</span>
    </button>
  );
};
