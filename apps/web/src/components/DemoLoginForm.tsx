"use client";

import { useState, type SyntheticEvent } from "react";

// The demo gate's sign-in form: the shared username and password. The server decides where to go next (a path on this site only).

export const DemoLoginForm = ({ next }: { next: string }) => {
  const [username, setUsername] = useState("");
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
        body: JSON.stringify({ username, password, next }),
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
        <label htmlFor="demo-username">Username</label>
        <input
          id="demo-username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="demo-password">Password</label>
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
      <button
        type="submit"
        className="button login-submit"
        disabled={busy || username.trim() === "" || password === ""}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
};
