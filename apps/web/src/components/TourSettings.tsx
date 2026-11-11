"use client";

import { useState } from "react";
import { useTour } from "@/components/TourProvider";

/** Settings' tour card: start the main tour again, or let the page tips show again. */
export const TourSettings = () => {
  const tour = useTour();
  const [message, setMessage] = useState<string | null>(null);
  const ready = tour?.ready ?? false;
  return (
    <>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready}
          onClick={() => {
            void tour?.restart();
          }}
        >
          Replay tour
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready}
          onClick={() => {
            void tour?.resetTips().then(() => {
              setMessage("Page tips will show again the next time you open each page.");
            });
          }}
        >
          Reset page tips
        </button>
      </div>
      {message ? (
        <p className="field-hint" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
};
