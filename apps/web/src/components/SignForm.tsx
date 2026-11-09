"use client";

import { useState, type SyntheticEvent } from "react";

// The public signing page's form. The client reads the document (in a sandboxed frame with no
// scripts), types their full name, ticks the consent box and presses Sign, or declines. Nothing
// here is trusted: the server checks every field again.

type Props = { token: string; html: string; freelancerName: string; clientName: string };

type Done = "signed" | "declined";
type Issue = { field: string; message: string };

const post = async (
  token: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; text: string }> => {
  try {
    const response = await fetch(`/api/sign/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const data = (await response.json()) as { error?: string; errors?: Issue[] };
    const first = data.errors?.[0];
    const label = first?.field === "name" ? "Full name" : first?.field;
    return {
      ok: false,
      text: first
        ? `${label ?? "Field"} ${first.message}`
        : (data.error ?? "That didn't work. Try again."),
    };
  } catch {
    return { ok: false, text: "That didn't work. Check your connection and try again." };
  }
};

export const SignForm = ({ token, html, freelancerName, clientName }: Props) => {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done>();

  const send = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const body = declining ? { action: "decline", reason } : { action: "sign", name, consent };
    const result = await post(token, body);
    setBusy(false);
    if (result.ok) setDone(declining ? "declined" : "signed");
    else setError(result.text);
  };

  if (done) {
    return (
      <div className="page">
        <div className="card" role="status">
          <h1>{done === "signed" ? "Thank you, it's signed" : "You declined the agreement"}</h1>
          <p>
            {done === "signed"
              ? `${freelancerName} will send you a copy of the signed agreement by email.`
              : `${freelancerName} has been told. You can close this page.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Agreement from {freelancerName}</h1>
      <p className="muted">For {clientName}. Read it all, then sign below or decline.</p>
      <iframe title="Agreement" sandbox="" srcDoc={html} className="template-preview" />
      <form className="form card" onSubmit={(event) => void send(event)} noValidate>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {declining ? (
          <div className="field">
            <label htmlFor="reason">Why are you declining? (optional)</label>
            <textarea
              id="reason"
              value={reason}
              maxLength={1000}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input
                id="name"
                value={name}
                maxLength={160}
                autoComplete="name"
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => {
                    setConsent(e.target.checked);
                  }}
                />{" "}
                I have read this agreement and agree to sign it electronically
              </label>
            </div>
          </>
        )}
        <div className="actions">
          <button className="button" type="submit" disabled={busy}>
            {declining ? "Decline the agreement" : "Sign"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setDeclining(!declining);
              setError(undefined);
            }}
          >
            {declining ? "Back to signing" : "Decline"}
          </button>
        </div>
      </form>
    </div>
  );
};
