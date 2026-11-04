"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import type { RetainerAlert } from "@/lib/retainers";

// The dashboard flag for what happened to a retainer: a cancellation, a failed charge.

export const RetainerAlerts = ({ alerts }: { alerts: RetainerAlert[] }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (alerts.length === 0) return null;

  const dismiss = async (id: string) => {
    setBusy(true);
    await sendJson(`/api/retainers/alerts/${id}`, "DELETE", {}, {});
    setBusy(false);
    router.refresh();
  };

  return (
    <section aria-label="Retainer alerts">
      {alerts.map((alert) => (
        <div key={alert.id} className="banner banner-warning" role="status">
          <p>{alert.text}</p>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void dismiss(alert.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </section>
  );
};
