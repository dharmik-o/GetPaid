"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Keeps the Outbox current while it's open, so a draft approved on Telegram moves on its own.
// A refresh keeps the page's state, so an edit in progress isn't lost.

const REFRESH_MS = 10_000;

export const OutboxLive = () => {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [router]);
  return null;
};
