"use client";

import { useEffect, useState } from "react";
import { SignForm } from "@/components/SignForm";

// The public signing page's data. It comes from GET /api/sign/[token], which answers a wrong, used or
// expired link with a plain 404, so this page says the same thing for all of them and nothing more.

type View = { html: string; freelancerName: string; clientName: string };
type State =
  { kind: "loading" } | { kind: "invalid" } | { kind: "busy" } | { kind: "ready"; view: View };

export const SignLoader = ({ token }: { token: string }) => {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/sign/${token}`, { signal: controller.signal });
        if (response.status === 429) setState({ kind: "busy" });
        else if (!response.ok) setState({ kind: "invalid" });
        else setState({ kind: "ready", view: (await response.json()) as View });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "invalid" });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [token]);

  if (state.kind === "ready") {
    return <SignForm token={token} {...state.view} />;
  }
  return (
    <div className="page">
      <p role={state.kind === "loading" ? "status" : "alert"}>
        {state.kind === "loading"
          ? "Loading the agreement…"
          : state.kind === "busy"
            ? "Too many requests. Wait a minute and reload this page."
            : "This signing link isn't valid. It may have been used already, or have expired. Ask the sender for a new one."}
      </p>
    </div>
  );
};
