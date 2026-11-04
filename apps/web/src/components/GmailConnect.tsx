"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GmailStatus } from "@/lib/gmail-account";

// Connect Gmail: reminders go out from your own address, and the app reads only the threads it
// started. Google's Testing mode ends the connection after 7 days; sends then wait for a reconnect.

type Props = {
  status: GmailStatus;
  email: string | null;
  configured: boolean;
  /** The outcome code in the address after Google's consent page. */
  outcome: string | null;
};

const OUTCOME_ERRORS: Record<string, string> = {
  denied:
    "Gmail wasn't connected, because the request was declined at Google. Try again to connect.",
  invalid_state:
    "That link expired or was already used, so Gmail wasn't connected. Press Connect again.",
  missing_scope:
    "Google didn't grant both permissions. Press Connect again and leave both boxes ticked.",
  no_refresh_token:
    "Google didn't give a lasting connection. Remove this app at myaccount.google.com/permissions, then press Connect again.",
  failed: "Gmail couldn't be connected. Check the OAuth client values, then press Connect again.",
};

const readError = async (response: Response): Promise<string> =>
  ((await response.json()) as { error?: string }).error ?? "That didn't work. Try again.";

export const GmailConnect = ({ status, email, configured, outcome }: Props) => {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const call = async (method: "POST" | "DELETE"): Promise<Response | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/integrations/gmail", {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) return response;
      setError(await readError(response));
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const connect = async () => {
    const response = await call("POST");
    if (!response) return;
    window.location.assign(((await response.json()) as { url: string }).url);
  };

  const disconnect = async () => {
    if (await call("DELETE")) router.refresh();
  };

  const problem = error ?? (outcome ? OUTCOME_ERRORS[outcome] : undefined);
  const alert = problem ? (
    <p className="banner banner-error" role="alert">
      {problem}
    </p>
  ) : null;

  const connectButton = (label: string) => (
    <button
      className="button"
      type="button"
      disabled={busy}
      onClick={() => {
        void connect();
      }}
    >
      {label}
    </button>
  );

  if (status === "connected") {
    return (
      <>
        <p>Connected as {email}. Approved reminders go out from this address.</p>
        {alert}
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void disconnect();
          }}
        >
          Disconnect Gmail
        </button>
      </>
    );
  }

  if (!configured) {
    return (
      <p className="muted">
        Gmail isn&apos;t set up yet: add <code>GOOGLE_CLIENT_ID</code> and{" "}
        <code>GOOGLE_CLIENT_SECRET</code> to your local env file and restart. Approved reminders
        wait until then.
      </p>
    );
  }

  if (status === "needs_reconnect") {
    return (
      <>
        <p className="banner banner-warning" role="status">
          Google ended the connection{email ? ` for ${email}` : ""}. Your approved reminders are
          held, not lost, and go out once you reconnect.
        </p>
        {alert}
        {connectButton("Reconnect Gmail")}
      </>
    );
  }

  return (
    <>
      <p>
        Send approved reminders from your own Gmail. The app asks to send and to read, but it will
        read only the threads it started with your clients, never the rest of your mailbox.
      </p>
      {alert}
      {connectButton("Connect Gmail")}
    </>
  );
};
