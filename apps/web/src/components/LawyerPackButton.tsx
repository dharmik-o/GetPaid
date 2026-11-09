"use client";

import { useState } from "react";

// "Lawyer pack" on the Project page: builds the PDF on the server and downloads it. The server also
// keeps a copy in the invoice archive folder.

export const LawyerPackButton = ({ projectId }: { projectId: string }) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const make = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/projects/${projectId}/lawyer-pack`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setMessage({ ok: false, text: body.error ?? "That didn't work. Try again." });
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "Lawyer-pack.pdf";
      link.click();
      URL.revokeObjectURL(url);
      setMessage({
        ok: true,
        text: "Your lawyer pack is downloading. A copy is in your invoice archive folder.",
      });
    } catch {
      setMessage({ ok: false, text: "That didn't work. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="button button-secondary"
        type="button"
        disabled={busy}
        onClick={() => {
          void make();
        }}
      >
        {busy ? "Building the pack…" : "Lawyer pack"}
      </button>
      {message ? (
        <p className={message.ok ? "field-hint" : "banner banner-error"} role="status">
          {message.text}
        </p>
      ) : null}
    </>
  );
};
