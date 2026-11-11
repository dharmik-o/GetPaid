"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { monthGrid, shiftMonth } from "@/lib/calendar-month";
import type { CalendarItem, CalendarItemType } from "@/lib/calendar-feed";
import type { LinkOption } from "@/lib/calendar-link-options";
import { CalendarDayPanel } from "./CalendarDayPanel";

// A month of the calendar: the six weeks that cover it. Previous / Today / Next fetch that month and
// swap only the grid (no page load, scroll stays). A day opens a panel listing what's on it, where
// your own entries can be added, changed and deleted. Colour is a hint only; every item's title says
// what it is.

/** Anything that changes the calendar elsewhere on the page (the assistant's Apply) sends this. */
export const CALENDAR_CHANGED = "calendar:changed";

const GROUP: Record<CalendarItemType, string> = {
  entry: "own",
  milestone_deadline: "deadline",
  hold_expiry: "deadline",
  agreement_deadline: "deadline",
  invoice_due: "money",
  retainer_charge: "money",
  reminder_send: "quiet",
  maintenance: "quiet",
  renewal: "quiet",
  imported: "quiet",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHOWN_PER_DAY = 3;

const monthName = (month: string): string =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

const dayName = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

const onDay = (items: CalendarItem[], day: string): CalendarItem[] =>
  items.filter((item) => item.startsOn <= day && day <= (item.endsOn ?? item.startsOn));

type Panel = { day: string; key: string | null };

export const CalendarMonth = ({
  month: firstMonth,
  today,
  items: firstItems,
  zone,
  links,
}: {
  month: string;
  today: string;
  items: CalendarItem[];
  zone: string;
  links: LinkOption[];
}) => {
  const router = useRouter();
  const [month, setMonth] = useState(firstMonth);
  const [items, setItems] = useState(firstItems);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [panel, setPanel] = useState<Panel | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(0);
  const shown = useRef(month);
  shown.current = month;

  // The old grid stays on screen until the new month arrives; only the last request counts.
  const load = useCallback(async (target: string, moveUrl: boolean) => {
    const request = ++latest.current;
    setLoading(true);
    setError(undefined);
    const days = monthGrid(target).flat();
    try {
      const response = await fetch(`/api/calendar?from=${days[0] ?? ""}&to=${days.at(-1) ?? ""}`);
      if (!response.ok) throw new Error(`calendar ${String(response.status)}`);
      const body = (await response.json()) as { items: CalendarItem[] };
      if (request !== latest.current) return;
      setItems(body.items);
      setMonth(target);
      if (moveUrl) window.history.replaceState(null, "", `/calendar?month=${target}`);
    } catch {
      if (request === latest.current) {
        setError("Couldn't load that month. Check your connection and try again.");
      }
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  const refreshHere = useCallback(() => {
    void load(shown.current, false);
    router.refresh(); // the agenda below is drawn by the server
  }, [load, router]);

  useEffect(() => {
    const onChanged = () => {
      void load(shown.current, false);
    };
    window.addEventListener(CALENDAR_CHANGED, onChanged);
    return () => {
      window.removeEventListener(CALENDAR_CHANGED, onChanged);
    };
  }, [load]);

  useEffect(() => {
    const element = dialog.current;
    if (panel !== null && element && !element.open) element.showModal();
  }, [panel]);

  const open = (day: string, key: string | null) => {
    setPanel({ day, key });
  };

  const closed = () => {
    const day = panel?.day;
    setPanel(null);
    // The browser returns focus to the button that was pressed; the day is what the person opened.
    if (day) document.querySelector<HTMLElement>(`[data-day="${day}"] .cal-daybtn`)?.focus();
  };

  return (
    <section className="card" aria-label="Month" data-tour="calendar-month">
      <div className="page-header">
        <h2>
          {monthName(month)}
          {loading ? <span className="muted"> Loading…</span> : null}
        </h2>
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(shiftMonth(month, -1), true)}
          >
            Previous
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(today.slice(0, 7), true)}
          >
            Today
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(shiftMonth(month, 1), true)}
          >
            Next
          </button>
        </div>
      </div>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cal-grid" role="grid" aria-label={monthName(month)} aria-busy={loading}>
        {WEEKDAYS.map((name) => (
          <div key={name} className="cal-weekday" role="columnheader">
            {name}
          </div>
        ))}
        {monthGrid(month)
          .flat()
          .map((day) => {
            const dayItems = onDay(items, day);
            return (
              <div
                key={day}
                role="gridcell"
                data-day={day}
                className={`cal-day${day.slice(0, 7) === month ? "" : " cal-outside"}${day === today ? " cal-today" : ""}`}
              >
                <button
                  type="button"
                  className="cal-daybtn"
                  aria-label={`${dayName(day)}, ${String(dayItems.length)} ${dayItems.length === 1 ? "item" : "items"}`}
                  onClick={() => {
                    open(day, null);
                  }}
                >
                  {Number(day.slice(8))}
                </button>
                {dayItems.slice(0, SHOWN_PER_DAY).map((item) => (
                  <button
                    type="button"
                    key={`${item.key}:${day}`}
                    className={`cal-item cal-${GROUP[item.type]}${item.status === "done" ? " cal-done" : ""}`}
                    title={item.title}
                    onClick={() => {
                      open(day, item.key);
                    }}
                  >
                    {item.isClientMeeting ? "● " : ""}
                    {item.title}
                  </button>
                ))}
                {dayItems.length > SHOWN_PER_DAY ? (
                  <span className="cal-more">+{dayItems.length - SHOWN_PER_DAY} more</span>
                ) : null}
              </div>
            );
          })}
      </div>
      <p className="field-hint">
        ● marks a client meeting. Gold: your entries. Red: deadlines. White: money. Grey: reminders
        and jobs. Click a day to see what is on it or to add an entry.
      </p>
      <dialog
        ref={dialog}
        className="cal-dialog"
        aria-labelledby="cal-panel-title"
        onClose={closed}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current.close();
        }}
      >
        {panel ? (
          <div className="cal-dialog-body">
            <CalendarDayPanel
              key={panel.day}
              day={panel.day}
              dayLabel={dayName(panel.day)}
              items={onDay(items, panel.day)}
              zone={zone}
              links={links}
              focusKey={panel.key}
              onChanged={refreshHere}
            />
            <button
              type="button"
              className="button button-secondary cal-dialog-close"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
          </div>
        ) : null}
      </dialog>
    </section>
  );
};
