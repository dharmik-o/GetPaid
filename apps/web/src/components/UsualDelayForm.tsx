"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";

// How late clients usually paid before this app, in the freelancer's own words. Days saved on Home
// is measured against it. Empty means unknown, and nothing is assumed.

const FIELD_NAMES = { usualDaysLate: "Usual delay" };

export const UsualDelayForm = ({ current }: { current: number | null }) => {
  const router = useRouter();
  const [days, setDays] = useState(current === null ? "" : String(current));
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    const usualDaysLate = days.trim() === "" ? null : Number(days);
    const result = await sendJson("/api/settings/account", "PUT", { usualDaysLate }, FIELD_NAMES);
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: "Saved." } : { ok: false, text: result.message });
    if (result.ok) router.refresh();
  };

  return (
    <form
      className="form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="field">
        <label htmlFor="usual-days-late">Days after the due date</label>
        <input
          id="usual-days-late"
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
          }}
        />
      </div>
      {message ? (
        <p className={message.ok ? "field-hint" : "banner banner-error"} role="status">
          {message.text}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
};
