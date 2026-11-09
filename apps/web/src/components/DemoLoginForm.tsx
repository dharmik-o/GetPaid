"use client";

import { useState, type SyntheticEvent } from "react";

// The demo gate's one-field form. The server decides where to go next (a path on this site only).

export const DemoLoginForm = ({ next }: { next: string }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/demo-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, next }),
      });
      const result = (await response.json()) as { next?: string; error?: string };
      if (!response.ok || !result.next) {
        setError(result.error ?? "Signing in failed. Try again.");
        return;
      }
      window.location.assign(result.next);
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)} noValidate>
      <div className="field">
        <label htmlFor="demo-password">Demo password</label>
        <input
          id="demo-password"
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <button type="submit" className="button" disabled={busy || password === ""}>
        {busy ? "Checking…" : "Open the demo"}
      </button>
    </form>
  );
};
