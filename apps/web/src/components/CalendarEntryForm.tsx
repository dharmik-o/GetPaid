"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson, type CallResult } from "@/lib/api-client";
import type { LinkOption } from "@/lib/calendar-link-options";

// Add or change one of the freelancer's own calendar entries. Only the most specific link is sent
// (milestone, else project, else client): the server fills in the rest, so they can never disagree.

export type EntryFormValues = {
  id?: string;
  title: string;
  kind: string;
  startsOn: string;
  endsOn: string;
  startTime: string;
  endTime: string;
  link: string;
  notes: string;
  remindOnDay: boolean;
  done?: boolean;
};

const FIELD_NAMES: Record<string, string> = {
  title: "Title",
  kind: "Kind",
  startsOn: "Date",
  endsOn: "Last day",
  startTime: "Start time",
  endTime: "End time",
  clientId: "Client",
  projectId: "Project",
  milestoneId: "Milestone",
  notes: "Notes",
};

const linkFields = (link: string): Record<string, string | null> => {
  const [kind, id] = link.split(":");
  return {
    clientId: kind === "client" ? (id ?? null) : null,
    projectId: kind === "project" ? (id ?? null) : null,
    milestoneId: kind === "milestone" ? (id ?? null) : null,
  };
};

/** `compact` is the form inside the calendar's day panel: no page change, no mark-done or delete
 *  (the panel has those), and `onDone` / `onCancel` tell the panel what happened. */
export type CompactHooks = { onDone: () => void; onCancel: () => void };

export const CalendarEntryForm = ({
  initial,
  links,
  compact,
}: {
  initial: EntryFormValues;
  links: LinkOption[];
  compact?: CompactHooks;
}) => {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof EntryFormValues>(key: K, value: EntryFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const allDay = values.startTime === "";
  const entryUrl = `/api/calendar/entries/${values.id ?? ""}`;

  const finish = (result: CallResult) => {
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (compact) {
      compact.onDone();
      return;
    }
    router.push("/calendar");
    router.refresh();
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    finish(
      await sendJson(
        values.id ? entryUrl : "/api/calendar/entries",
        values.id ? "PATCH" : "POST",
        {
          title: values.title,
          kind: values.kind,
          startsOn: values.startsOn,
          endsOn: allDay && values.endsOn !== "" ? values.endsOn : null,
          startTime: allDay ? null : values.startTime,
          endTime: allDay || values.endTime === "" ? null : values.endTime,
          notes: values.notes.trim() === "" ? null : values.notes,
          remindOnDay: values.remindOnDay,
          ...linkFields(values.link),
        },
        FIELD_NAMES,
      ),
    );
  };

  const markDone = async () => {
    setBusy(true);
    setError(undefined);
    finish(await sendJson(entryUrl, "PATCH", { done: !values.done }, FIELD_NAMES));
  };

  const remove = async () => {
    if (!window.confirm("Delete this entry? This can't be undone.")) return;
    setBusy(true);
    setError(undefined);
    finish(await sendJson(entryUrl, "DELETE", {}, FIELD_NAMES));
  };

  return (
    <form className={compact ? "form" : "card form"} onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor="entry-title">Title</label>
        <input
          id="entry-title"
          value={values.title}
          required
          maxLength={200}
          onChange={(event) => {
            set("title", event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="entry-kind">Kind</label>
        <select
          id="entry-kind"
          value={values.kind}
          onChange={(event) => {
            set("kind", event.target.value);
          }}
        >
          <option value="task">Task</option>
          <option value="event">Event</option>
          <option value="deadline">Deadline</option>
          <option value="call">Call</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="entry-date">Date</label>
        <input
          id="entry-date"
          type="date"
          value={values.startsOn}
          required
          onChange={(event) => {
            set("startsOn", event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="entry-start">Start time (leave empty for all day)</label>
        <input
          id="entry-start"
          type="time"
          value={values.startTime}
          onChange={(event) => {
            set("startTime", event.target.value);
          }}
        />
      </div>
      {allDay ? (
        <div className="field">
          <label htmlFor="entry-last-day">Last day (optional, for several days)</label>
          <input
            id="entry-last-day"
            type="date"
            value={values.endsOn}
            onChange={(event) => {
              set("endsOn", event.target.value);
            }}
          />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="entry-end">End time (optional)</label>
          <input
            id="entry-end"
            type="time"
            value={values.endTime}
            onChange={(event) => {
              set("endTime", event.target.value);
            }}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="entry-link">Linked to (optional)</label>
        <select
          id="entry-link"
          value={values.link}
          onChange={(event) => {
            set("link", event.target.value);
          }}
        >
          <option value="">Nothing</option>
          {links.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="entry-notes">Notes (optional)</label>
        <textarea
          id="entry-notes"
          rows={3}
          maxLength={5000}
          value={values.notes}
          onChange={(event) => {
            set("notes", event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="entry-remind">
          <input
            id="entry-remind"
            type="checkbox"
            checked={values.remindOnDay}
            onChange={(event) => {
              set("remindOnDay", event.target.checked);
            }}
          />{" "}
          Remind me on Telegram that morning
        </label>
      </div>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Saving…" : values.id ? "Save changes" : "Add entry"}
        </button>
        {values.id && !compact ? (
          <>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={() => void markDone()}
            >
              {values.done ? "Mark as not done" : "Mark done"}
            </button>
            <button
              className="button button-danger"
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </>
        ) : null}
        {compact ? (
          <button className="button button-secondary" type="button" onClick={compact.onCancel}>
            Cancel
          </button>
        ) : (
          <Link className="button button-secondary" href="/calendar">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
};
