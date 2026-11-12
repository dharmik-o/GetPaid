"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Settings > AI: drop the user's own model and key, and go back to the server's built-in model.

export const UseBuiltInAi = ({ label, model }: { label: string; model: string }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const reset = async () => {
    if (
      !window.confirm(`Remove your own model and key, and use the built-in ${label} model again?`)
    )
      return;
    setBusy(true);
    setProblem(undefined);
    try {
      const response = await fetch("/api/settings/ai", { method: "DELETE" });
      if (!response.ok) {
        setProblem("That didn't work. Try again in a moment.");
        return;
      }
      router.refresh();
    } catch {
      setProblem("That didn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() => void reset()}
      >
        Use the built-in model ({model}) instead
      </button>
      {problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
};
