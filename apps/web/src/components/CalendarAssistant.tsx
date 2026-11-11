"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";
import { CALENDAR_CHANGED } from "./CalendarMonth";

// The calendar assistant: ask a question, read the answer, and press Apply on any change it proposes.
// Nothing changes until Apply. The last 3 exchanges live in this component only; the server keeps none.

type Proposal =
  | {
      op: "move";
      key: string;
      startsOn: string;
      startTime: string | null;
      endTime: string | null;
      reason: string;
      title: string | null;
    }
  | {
      op: "create";
      title: string;
      kind: string;
      startsOn: string;
      startTime: string | null;
      endTime: string | null;
      clientName: string | null;
      reason: string;
    }
  | { op: "mark_done"; key: string; reason: string; title: string | null }
  | { op: "delete"; key: string; reason: string; title: string | null };

type Answer = {
  answer: string;
  references: { key: string; title: string; href: string }[];
  proposals: Proposal[];
};

type Turn = { q: string; a: string };

type CardState =
  { status: "working" | "applied" | "dismissed" } | { status: "error"; message: string };

const EXAMPLES = ["Deadlines next week", "What's overdue?", "Plan my Friday"];
const MAX_HISTORY = 3;
const NAMES: Record<string, string> = { proposal: "Proposal", key: "Entry" };

const when = (date: string, start: string | null, end: string | null): string =>
  start === null ? `${date}, all day` : `${date}, ${start}${end ? `–${end}` : ""}`;

const describe = (proposal: Proposal): string => {
  switch (proposal.op) {
    case "move":
      return `Move “${proposal.title ?? "an entry"}” to ${when(proposal.startsOn, proposal.startTime, proposal.endTime)}`;
    case "create":
      return `Add “${proposal.title}” on ${when(proposal.startsOn, proposal.startTime, proposal.endTime)}${proposal.clientName ? ` for ${proposal.clientName}` : ""}`;
    case "mark_done":
      return `Mark “${proposal.title ?? "an entry"}” done`;
    case "delete":
      return `Delete “${proposal.title ?? "an entry"}”`;
  }
};

/** Only the fields the server's schema knows; the title is for display. */
const forApply = (proposal: Proposal): object => {
  const { op } = proposal;
  if (op === "create") {
    const { title, kind, startsOn, startTime, endTime, clientName, reason } = proposal;
    return { op, title, kind, startsOn, startTime, endTime, clientName, reason };
  }
  if (op === "move") {
    const { key, startsOn, startTime, endTime, reason } = proposal;
    return { op, key, startsOn, startTime, endTime, reason };
  }
  return { op, key: proposal.key, reason: proposal.reason };
};

export const CalendarAssistant = () => {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<Answer>();
  const [states, setStates] = useState<Record<number, CardState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/calendar/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed, history }),
      });
      const body = (await response.json()) as Answer & {
        error?: string;
        errors?: { field: string; message: string }[];
      };
      if (!response.ok) {
        const first = body.errors?.[0];
        setError(
          first
            ? `${first.field} ${first.message}`
            : (body.error ?? "That didn't work. Try again."),
        );
      } else {
        setAnswer(body);
        setStates({});
        setHistory((current) =>
          [...current, { q: trimmed, a: body.answer.slice(0, 1000) }].slice(-MAX_HISTORY),
        );
        setQuestion("");
      }
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  };

  const apply = async (index: number, proposal: Proposal) => {
    setStates((current) => ({ ...current, [index]: { status: "working" } }));
    const result = await sendJson(
      "/api/calendar/assistant/apply",
      "POST",
      { proposal: forApply(proposal) },
      NAMES,
    );
    setStates((current) => ({
      ...current,
      [index]: result.ok ? { status: "applied" } : { status: "error", message: result.message },
    }));
    if (result.ok) {
      window.dispatchEvent(new Event(CALENDAR_CHANGED)); // redraw the month grid in place
      router.refresh();
    }
  };

  return (
    <section className="card" aria-labelledby="assistant" data-tour="calendar-assistant">
      <h2 id="assistant">Ask about your calendar</h2>
      <p className="muted">
        It answers from your calendar only, and can suggest changes to your own entries. Nothing
        changes until you press Apply.
      </p>
      <div className="actions">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            className="chip"
            type="button"
            disabled={busy}
            onClick={() => void ask(example)}
          >
            {example}
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
        <div className="field">
          <label htmlFor="assistant-question">Your question</label>
          <input
            id="assistant-question"
            value={question}
            maxLength={500}
            placeholder="Move the logo review to Friday"
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
          />
        </div>
        <div className="actions">
          <button className="button" type="submit" disabled={busy || question.trim() === ""}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {answer ? (
        <div aria-live="polite">
          <p>{answer.answer}</p>
          {answer.references.length > 0 ? (
            <p className="field-hint">
              Based on:{" "}
              {answer.references.map((reference, index) => (
                <span key={reference.key}>
                  {index > 0 ? ", " : ""}
                  <Link href={reference.href}>{reference.title}</Link>
                </span>
              ))}
            </p>
          ) : null}
          {answer.proposals.map((proposal, index) => {
            const state = states[index];
            return (
              <div key={`${proposal.op}-${String(index)}`} className="card">
                <p>
                  <strong>{describe(proposal)}</strong>
                </p>
                {proposal.reason ? <p className="muted">{proposal.reason}</p> : null}
                {state?.status === "applied" ? <p role="status">Done.</p> : null}
                {state?.status === "dismissed" ? <p className="muted">Dismissed.</p> : null}
                {state?.status === "error" ? (
                  <p className="banner banner-error" role="alert">
                    {state.message}
                  </p>
                ) : null}
                {state === undefined || state.status === "error" ? (
                  <div className="actions">
                    <button
                      className="button"
                      type="button"
                      onClick={() => void apply(index, proposal)}
                    >
                      Apply
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => {
                        setStates((current) => ({ ...current, [index]: { status: "dismissed" } }));
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
