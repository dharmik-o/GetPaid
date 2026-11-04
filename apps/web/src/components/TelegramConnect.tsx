"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Connect Telegram: a one-time link opens the bot, and the bot saves this chat on the account.
// While a link is open the page checks for the connection, so it updates on its own.

type Props = { connected: boolean; configured: boolean };

const CHECK_EVERY_MS = 3000;

const readError = async (response: Response): Promise<string> =>
  ((await response.json()) as { error?: string }).error ?? "That didn't work. Try again.";

export const TelegramConnect = ({ connected, configured }: Props) => {
  const router = useRouter();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!link || connected) return undefined;
    const timer = setInterval(() => {
      router.refresh();
    }, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
    };
  }, [link, connected, router]);

  const call = async (method: "POST" | "DELETE"): Promise<Response | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/telegram/link", {
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

  const start = async () => {
    const response = await call("POST");
    if (response) setLink(((await response.json()) as { url: string }).url);
  };

  const disconnect = async () => {
    if (await call("DELETE")) {
      setLink(undefined);
      router.refresh();
    }
  };

  const alert = error ? (
    <p className="banner banner-error" role="alert">
      {error}
    </p>
  ) : null;

  if (connected) {
    return (
      <>
        <p>Connected. Reminder drafts arrive in your Telegram chat as well as the Outbox.</p>
        {alert}
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void disconnect();
          }}
        >
          Disconnect Telegram
        </button>
      </>
    );
  }

  if (!configured) {
    return (
      <p className="muted">
        Telegram isn&apos;t set up yet: add <code>TELEGRAM_BOT_USERNAME</code> to your local env
        file and restart. You can still approve everything in the Outbox.
      </p>
    );
  }

  return (
    <>
      <p>Optional. Approve drafts from your phone. You can always use the Outbox instead.</p>
      <p className="field-hint">
        Telegram bot chats aren&apos;t end-to-end encrypted, so drafts pass through Telegram&apos;s
        servers.
      </p>
      {alert}
      {link ? (
        <div role="status">
          <p>
            <a className="button" href={link} target="_blank" rel="noreferrer">
              Open Telegram and press Start
            </a>
          </p>
          <p className="field-hint">
            Waiting for you to press Start. This link works once, for 15 minutes.
          </p>
        </div>
      ) : (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            void start();
          }}
        >
          Connect Telegram
        </button>
      )}
    </>
  );
};
