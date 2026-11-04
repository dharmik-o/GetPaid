"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";

// The freelancer's own time zone, for the "yours" half of every send time in the Outbox.

type Props = { current: string; zones: string[] };

export const TimeZoneForm = ({ current, zones }: Props) => {
  const router = useRouter();
  const [timeZone, setTimeZone] = useState(current);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const options = zones.includes(current) ? zones : [current, ...zones];

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await sendJson(
      "/api/settings/account",
      "PUT",
      { timeZone },
      {
        timeZone: "Time zone",
      },
    );
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
        <label htmlFor="own-time-zone">Your time zone</label>
        <select
          id="own-time-zone"
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value);
          }}
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      {message ? (
        <p className={message.ok ? "field-hint" : "banner banner-error"} role="status">
          {message.text}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Save time zone
        </button>
      </div>
    </form>
  );
};
