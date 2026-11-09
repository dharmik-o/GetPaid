"use client";

import { useState } from "react";

// Download the calendar as an .ics file. The ranges are worked out on the server in the freelancer's
// zone and passed in; notes are left out unless the box is ticked.

export type ExportRange = { label: string; from: string | null; to: string | null };

export const CalendarExport = ({ ranges }: { ranges: ExportRange[] }) => {
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState(false);
  const range = ranges[index];
  const params = new URLSearchParams();
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  if (notes) params.set("notes", "1");
  const query = params.toString();
  return (
    <section className="card" aria-label="Export">
      <h2>Export</h2>
      <p className="muted">
        Download your entries and the app&apos;s dates as an .ics file for Google Calendar, Outlook
        or Apple Calendar. Calendars you imported are never included.
      </p>
      <div className="field">
        <label htmlFor="export-range">What to include</label>
        <select
          id="export-range"
          value={index}
          onChange={(event) => {
            setIndex(Number(event.target.value));
          }}
        >
          {ranges.map((option, position) => (
            <option key={option.label} value={position}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="export-notes">
          <input
            id="export-notes"
            type="checkbox"
            checked={notes}
            onChange={(event) => {
              setNotes(event.target.checked);
            }}
          />{" "}
          Include notes
        </label>
      </div>
      <a className="button" href={`/api/calendar/export.ics${query ? `?${query}` : ""}`} download>
        Download .ics
      </a>
    </section>
  );
};
