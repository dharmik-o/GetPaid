"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";

// "Mark project complete": the server refuses while an invoice or a hold is still open, and says
// which, so this only confirms and shows what it said.

export const CompleteProject = ({ projectId }: { projectId: string }) => {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const complete = async () => {
    setBusy(true);
    const result = await sendJson(`/api/projects/${projectId}/complete`, "POST", {}, {});
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setConfirming(false);
    router.refresh();
  };

  if (!confirming) {
    return (
      <button
        className="button button-secondary"
        type="button"
        onClick={() => {
          setProblem(undefined);
          setConfirming(true);
        }}
      >
        Mark project complete
      </button>
    );
  }
  return (
    <div className="editor-form" role="group" aria-label="Mark project complete">
      <p>
        Mark this project complete? Every invoice must be paid or cancelled, and any milestone hold
        captured or voided first. Its waiting reminders stop.
      </p>
      {problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="button" disabled={busy} onClick={() => void complete()}>
          {busy ? "Completing…" : "Mark complete"}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
          }}
        >
          Not yet
        </button>
      </div>
    </div>
  );
};
