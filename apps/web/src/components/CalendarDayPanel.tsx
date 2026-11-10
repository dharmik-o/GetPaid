"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sendJson } from "@/lib/api-client";
import type { CalendarItem, CalendarItemType } from "@/lib/calendar-feed";
import type { LinkOption } from "@/lib/calendar-link-options";
import { CalendarEntryForm, type EntryFormValues } from "./CalendarEntryForm";

// What one day holds. App-made and imported items are read-only here: a description, and a link to
// the page that owns them. Your own entries can be changed or deleted in place. Imported titles and
// descriptions are untrusted text: React renders them as plain text, and nothing here turns them into
// links.

const TYPE_LABEL: Record<CalendarItemType, string> = {
  entry: "Your entry",
  milestone_deadline: "Deadline",
  invoice_due: "Invoice due",
  reminder_send: "Planned reminder",
  maintenance: "Maintenance",
  renewal: "Renewal",
  retainer_charge: "Retainer charge",
  hold_expiry: "Hold expiry",
  agreement_deadline: "Agreement",
  imported: "Imported",
};

/** Where an app-made item's page link leads. Own entries and imported events have none. */
const OPEN_LABEL: Partial<Record<CalendarItemType, string>> = {
  milestone_deadline: "Open project",
  hold_expiry: "Open project",
  invoice_due: "Open invoice",
  agreement_deadline: "Open agreement",
  reminder_send: "Open outbox",
  maintenance: "Open maintenance",
  renewal: "Open maintenance",
  retainer_charge: "Open retainers",
};

const entryId = (item: CalendarItem): string => item.key.replace("entry:", "");

const clock = (instant: string, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(
    new Date(instant),
  );

const whenOf = (item: CalendarItem, zone: string): string =>
  item.startAt === null
    ? "All day"
    : `${clock(item.startAt, zone)}${item.endAt === null ? "" : `–${clock(item.endAt, zone)}`}`;

const formValues = (item: CalendarItem): EntryFormValues => ({
  id: entryId(item),
  title: item.title,
  kind: item.own?.kind ?? "task",
  startsOn: item.own?.startsOn ?? item.startsOn,
  endsOn: item.endsOn ?? "",
  startTime: item.own?.startTime ?? "",
  endTime: item.own?.endTime ?? "",
  link: item.own?.linkValue ?? "",
  notes: item.notes ?? "",
  remindOnDay: item.own?.remindOnDay ?? false,
  done: item.status === "done",
});

const blankEntry = (day: string): EntryFormValues => ({
  title: "",
  kind: "task",
  startsOn: day,
  endsOn: "",
  startTime: "",
  endTime: "",
  link: "",
  notes: "",
  remindOnDay: false,
});

export const CalendarDayPanel = ({
  day,
  dayLabel,
  items,
  zone,
  links,
  focusKey,
  onChanged,
}: {
  day: string;
  dayLabel: string;
  items: CalendarItem[];
  zone: string;
  links: LinkOption[];
  focusKey: string | null;
  onChanged: () => void;
}) => {
  const [editing, setEditing] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (focusKey === null) return;
    [...(list.current?.children ?? [])]
      .find((row) => row.getAttribute("data-key") === focusKey)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusKey]);

  const remove = async (item: CalendarItem) => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/calendar/entries/${entryId(item)}`, "DELETE", {}, {});
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setConfirming(undefined);
    onChanged();
  };

  return (
    <>
      <h2 id="cal-panel-title">{dayLabel}</h2>
      {items.length === 0 ? <p className="muted">Nothing on this day yet.</p> : null}
      <ul className="cal-panel-list" ref={list}>
        {items.map((item) => {
          const openLabel = OPEN_LABEL[item.type];
          return (
            <li
              key={item.key}
              data-key={item.key}
              className={item.key === focusKey ? "cal-panel-row cal-panel-focus" : "cal-panel-row"}
            >
              {editing === item.key ? (
                <CalendarEntryForm
                  compact={{
                    onDone: () => {
                      setEditing(undefined);
                      onChanged();
                    },
                    onCancel: () => {
                      setEditing(undefined);
                    },
                  }}
                  links={links}
                  initial={formValues(item)}
                />
              ) : (
                <>
                  <p className="field-hint">
                    <span className="badge chip">{TYPE_LABEL[item.type]}</span> {whenOf(item, zone)}
                    {item.type === "imported" && item.sourceName ? ` · ${item.sourceName}` : ""}
                  </p>
                  <p className="cal-panel-title">{item.title}</p>
                  <p className="muted">{item.summary}</p>
                  {item.notes ? <p className="cal-panel-notes">{item.notes}</p> : null}
                  <div className="actions">
                    {openLabel ? (
                      <Link className="link-button" href={item.href}>
                        {openLabel}
                      </Link>
                    ) : null}
                    {item.editable && confirming !== item.key ? (
                      <>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            setEditing(item.key);
                            setAdding(false);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="link-button button-danger"
                          onClick={() => {
                            setConfirming(item.key);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                    {confirming === item.key ? (
                      <>
                        <span role="alert">Delete this entry? This can&apos;t be undone.</span>
                        <button
                          type="button"
                          className="link-button button-danger"
                          disabled={busy}
                          onClick={() => void remove(item)}
                        >
                          Yes, delete
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() => {
                            setConfirming(undefined);
                          }}
                        >
                          Keep it
                        </button>
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {adding ? (
        <CalendarEntryForm
          compact={{
            onDone: () => {
              setAdding(false);
              onChanged();
            },
            onCancel: () => {
              setAdding(false);
            },
          }}
          links={links}
          initial={blankEntry(day)}
        />
      ) : (
        <button
          type="button"
          className="button"
          onClick={() => {
            setAdding(true);
            setEditing(undefined);
          }}
        >
          Add entry on {dayLabel}
        </button>
      )}
    </>
  );
};
