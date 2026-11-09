"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";
import { SOURCE_ERROR_WORDS } from "@/lib/calendar-source-words";
import { formatDateTime } from "@/lib/format";

// Imported calendars: add one by its secret iCal address or an .ics file, switch it on or off, refresh
// it, remove it. The address is sent once and never comes back: only its host is shown.

export type SourceRow = {
  id: string;
  name: string;
  kind: "url" | "file";
  urlHost: string | null;
  color: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  eventCount: number;
};

const COLORS = ["gray", "blue", "green", "purple", "orange", "pink"];
const NAMES: Record<string, string> = {
  name: "Name",
  url: "Address",
  color: "Colour",
  file: "File",
};

const uploadFile = async (name: string, color: string, file: File): Promise<string | undefined> => {
  try {
    const query = new URLSearchParams({ name, color }).toString();
    const response = await fetch(`/api/calendar/sources/upload?${query}`, {
      method: "PUT",
      headers: { "content-type": "text/calendar" },
      body: file,
    });
    if (response.ok) return undefined;
    const body = (await response.json()) as {
      error?: string;
      errors?: { field: string; message: string }[];
    };
    const first = body.errors?.[0];
    return first ? `${NAMES[first.field] ?? first.field} ${first.message}` : body.error;
  } catch {
    return "That didn't reach the server. Check your connection and try again.";
  }
};

const ColorSelect = ({
  id,
  label,
  value,
  disabled,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onPick: (color: string) => void;
}) => (
  <select
    id={id}
    aria-label={label}
    value={value}
    disabled={disabled}
    onChange={(event) => {
      onPick(event.target.value);
    }}
  >
    {COLORS.map((option) => (
      <option key={option} value={option}>
        {option}
      </option>
    ))}
  </select>
);

export const CalendarSources = ({ sources, zone }: { sources: SourceRow[]; zone: string }) => {
  const router = useRouter();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [color, setColor] = useState("gray");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const done = (error: string | undefined, text: string): boolean => {
    setBusy(false);
    setMessage(error ? { text: error, error: true } : { text, error: false });
    if (!error) router.refresh();
    return !error;
  };

  const add = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    const result = await sendJson(
      "/api/calendar/sources",
      "POST",
      { name, url: address, color },
      NAMES,
    );
    const added = done(
      result.ok ? undefined : result.message,
      "Calendar added. How its first sync went is in the list below.",
    );
    if (added) {
      setName("");
      setAddress("");
    }
  };

  const upload = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage(undefined);
    if (done(await uploadFile(fileName, color, file), "File imported.")) {
      setFileName("");
      setFile(null);
    }
  };

  const change = async (
    id: string,
    method: "PATCH" | "POST" | "DELETE",
    body: object,
    text: string,
  ) => {
    setBusy(true);
    setMessage(undefined);
    const result = await sendJson(`/api/calendar/sources/${id}`, method, body, NAMES);
    done(result.ok ? undefined : result.message, text);
  };

  const status = (source: SourceRow): string => {
    if (source.lastError) {
      return SOURCE_ERROR_WORDS[source.lastError] ?? "The last sync failed.";
    }
    if (!source.lastSyncedAt) return "Not synced yet";
    const when = formatDateTime(new Date(source.lastSyncedAt), zone);
    return `${String(source.eventCount)} events, ${source.kind === "url" ? "synced" : "imported"} ${when}`;
  };

  return (
    <>
      <section className="card" aria-labelledby="add-calendar">
        <h2 id="add-calendar">Add a calendar</h2>
        <p className="muted">
          Events from other calendars show up next to yours, read-only. Nothing is ever written back
          to them. Treat the secret address like a password: anyone who has it can read that
          calendar.
        </p>
        <ul className="muted">
          <li>
            <strong>Google:</strong> Settings, pick the calendar, Integrate calendar, then copy
            &quot;Secret address in iCal format&quot;.
          </li>
          <li>
            <strong>Outlook:</strong> Settings, Calendar, Shared calendars, Publish a calendar, then
            copy the ICS link.
          </li>
          <li>
            <strong>iCloud:</strong> in Calendar, share the calendar, turn on Public Calendar, then
            copy the link.
          </li>
        </ul>
        <form className="form" onSubmit={(event) => void add(event)}>
          <div className="field">
            <label htmlFor="source-name">Name</label>
            <input
              id="source-name"
              value={name}
              required
              maxLength={80}
              placeholder="Work (Google)"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="source-url">Secret iCal address</label>
            <input
              id="source-url"
              value={address}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="https://… or webcal://…"
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="source-color">Colour</label>
            <ColorSelect id="source-color" label="Colour" value={color} onPick={setColor} />
          </div>
          <div className="actions">
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Working…" : "Add calendar"}
            </button>
          </div>
        </form>
        <h3>Or upload an .ics file</h3>
        <p className="muted">A file is read once and isn&apos;t refreshed. Up to 2 MB.</p>
        <form className="form" onSubmit={(event) => void upload(event)}>
          <div className="field">
            <label htmlFor="file-name">Name</label>
            <input
              id="file-name"
              value={fileName}
              required
              maxLength={80}
              onChange={(event) => {
                setFileName(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="file-input">File</label>
            <input
              id="file-input"
              type="file"
              accept=".ics,text/calendar"
              required
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
              }}
            />
          </div>
          <div className="actions">
            <button className="button button-secondary" type="submit" disabled={busy || !file}>
              Upload
            </button>
          </div>
        </form>
        {message ? (
          <p
            className={message.error ? "banner banner-error" : "banner"}
            role={message.error ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="your-calendars">
        <h2 id="your-calendars">Your imported calendars</h2>
        {sources.length === 0 ? (
          <p className="muted">None yet. Add one above and its events appear on your calendar.</p>
        ) : (
          <div className="table-scroll">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th scope="col">Calendar</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td data-label="Calendar">
                      {source.name}
                      <div className="field-hint">
                        {source.kind === "url" ? source.urlHost : "Uploaded file"}
                      </div>
                    </td>
                    <td data-label="Status">
                      {status(source)}
                      {source.lastError && source.lastSyncedAt ? (
                        <div className="field-hint">
                          Showing the last good copy, from{" "}
                          {formatDateTime(new Date(source.lastSyncedAt), zone)}.
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Actions">
                      <div className="actions">
                        <label>
                          <input
                            type="checkbox"
                            checked={source.enabled}
                            disabled={busy}
                            onChange={(event) =>
                              void change(
                                source.id,
                                "PATCH",
                                { enabled: event.target.checked },
                                event.target.checked ? "Calendar shown." : "Calendar hidden.",
                              )
                            }
                          />{" "}
                          Show
                        </label>
                        <ColorSelect
                          id={`color-${source.id}`}
                          label={`Colour of ${source.name}`}
                          value={source.color}
                          disabled={busy}
                          onPick={(picked) =>
                            void change(source.id, "PATCH", { color: picked }, "Colour changed.")
                          }
                        />
                        {source.kind === "url" ? (
                          <button
                            className="button button-secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void change(source.id, "POST", {}, "Refreshed.")}
                          >
                            Refresh now
                          </button>
                        ) : null}
                        <button
                          className="button button-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${source.name}? Its events disappear from your calendar.`,
                              )
                            ) {
                              void change(source.id, "DELETE", {}, "Calendar removed.");
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
