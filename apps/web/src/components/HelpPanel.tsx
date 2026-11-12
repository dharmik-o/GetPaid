"use client";

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { HelpAnswerView, type HelpAnswerData } from "@/components/HelpAnswerView";
import { Icon } from "@/components/Icon";
import { MAX_QUESTION_CHARS } from "@/lib/help-limits";

// "Ask GetPaid": a Help button in the header that opens a side panel. It only explains, from the
// manual; it can't change anything. The question and answer live in this component only.

const SUGGESTIONS = [
  "How do I record a bank transfer?",
  "How do I connect Telegram?",
  "How do reminders work?",
];

type ApiBody = Partial<HelpAnswerData> & {
  error?: string;
  errors?: { field: string; message: string }[];
};

export const HelpPanel = () => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<HelpAnswerData>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        opener.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setQuestion(trimmed);
    setBusy(true);
    setError(undefined);
    setAnswer(undefined);
    try {
      const response = await fetch("/api/help", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = (await response.json()) as ApiBody;
      if (response.ok && body.answer !== undefined) {
        setAnswer({ answer: body.answer, sources: body.sources ?? [], links: body.links ?? [] });
      } else {
        const first = body.errors?.[0];
        setError(
          first
            ? `Your question ${first.message}.`
            : (body.error ?? "That didn't work. Try again."),
        );
      }
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="icon-button help-button"
        aria-label="Help"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tour="help"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="help" />
      </button>
      {open ? (
        <>
          <div
            className="help-backdrop"
            onClick={() => {
              setOpen(false);
            }}
          />
          <aside className="help-panel" role="dialog" aria-modal="true" aria-labelledby={id}>
            <div className="help-head">
              <h2 id={id}>Ask GetPaid</h2>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setOpen(false);
                  opener.current?.focus();
                }}
              >
                Close
              </button>
            </div>
            <p className="muted">
              Ask how to use GetPaid. It answers from the manual only, and can&apos;t change
              anything.
            </p>
            <div className="actions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => void ask(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <form
              className="form"
              onSubmit={(event: SyntheticEvent) => {
                event.preventDefault();
                void ask(question);
              }}
            >
              <label htmlFor={`${id}-q`}>Your question</label>
              <textarea
                id={`${id}-q`}
                ref={input}
                rows={3}
                maxLength={MAX_QUESTION_CHARS}
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void ask(question);
                  }
                }}
              />
              <div className="actions">
                <button className="button" type="submit" disabled={busy || question.trim() === ""}>
                  {busy ? "Looking it up…" : "Ask"}
                </button>
              </div>
            </form>
            <div aria-live="polite">
              {error ? (
                <p className="banner banner-error" role="alert">
                  {error}
                </p>
              ) : null}
              {answer ? <HelpAnswerView {...answer} /> : null}
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
};
