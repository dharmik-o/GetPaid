"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";

// Settings, in development only: jumps the demo clock without restarting the server.

const FIELD_NAMES = { days: "Days ahead" };

export const DemoClockForm = ({ current }: { current: number }) => {
  const router = useRouter();
  const [days, setDays] = useState(String(current));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await sendJson("/api/dev/clock", "POST", { days: Number(days) }, FIELD_NAMES);
    setBusy(false);
    setError(result.ok ? undefined : result.message);
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
        <label htmlFor="demo-clock-days">Days ahead</label>
        <input
          id="demo-clock-days"
          inputMode="decimal"
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
          }}
        />
        <p className="field-hint">
          Part of a day works, to land inside a send window: 18.5 is 18 days and 12 hours.
        </p>
      </div>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Set the clock
        </button>
      </div>
    </form>
  );
};
