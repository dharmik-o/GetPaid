import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIcsEvents } from "@/lib/calendar-import";
import { calendarItems } from "@/lib/calendar-feed";
import { calendarSourceHandlers } from "@/lib/calendar-source-handlers";
import { runCalendarSync } from "@/lib/calendar-sync";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { safeFetchText } from "@/lib/safe-fetch";
import { runAsService } from "@/lib/service-db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// A-S4 (the secret address never leaves the server), A-S5 (parsing) and A-C1 (connectivity), with
// real migrations and RLS (PGlite) and the calendar server played by msw. DNS is faked, so no real
// network is used.

const A = USER_A.userId;
const SECRET_PATH = "secret-abc123xyz";
const FEED = `https://calendar.google.com/calendar/ical/${SECRET_PATH}/basic.ics`;
const RANGE = { from: "2026-11-01", to: "2027-12-01" };
const PUBLIC = [{ address: "142.250.80.46", family: 4 as const }];
const box = createSecretBox(randomBytes(32));
const server = setupServer();
let handle: TestDatabase;
let clock = new Date("2026-12-01T10:00:00Z");

const calendar = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

const WEEKLY = calendar(
  vevent(
    "UID:weekly@test",
    "DTSTART:20261201T100000Z",
    "DTEND:20261201T110000Z",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "EXDATE:20261208T100000Z",
    "SUMMARY:Weekly sync",
  ),
  vevent(
    "UID:weekly@test",
    "RECURRENCE-ID:20261215T100000Z",
    "DTSTART:20261216T150000Z",
    "DTEND:20261216T160000Z",
    "SUMMARY:Weekly sync (moved)",
  ),
);

const deps = () => ({
  box: () => box,
  now: () => clock,
  fetchText: (address: string) =>
    safeFetchText(address, {}, { resolve: () => Promise.resolve(PUBLIC) }),
});
const as = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, A, work);
const handlers = () => calendarSourceHandlers({ runAsUser: as, ...deps() });
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const serveFeed = (body: string, status = 200): void => {
  server.use(http.get(FEED, () => new HttpResponse(body, { status })));
};

beforeAll(async () => {
  server.listen({ onUnhandledFrame: "error" });
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  // The seed's own imported source and event would blur the counts below.
  await handle.db.query("DELETE FROM public.calendar_sources");
}, 60_000);

beforeEach(async () => {
  clock = new Date("2026-12-01T10:00:00Z");
  await handle.db.query("DELETE FROM public.calendar_sources");
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  server.close();
  await handle.close();
});

const add = async (name = "Work (Google)") => {
  const response = await handlers().add(
    new Request("http://x.test/api/calendar/sources", json({ name, url: FEED, color: "blue" })),
  );
  return { response, body: (await response.clone().json()) as { source: { id: string } } };
};

describe("parsing (A-S5)", () => {
  it("expands a weekly event, skips the EXDATE and applies the moved occurrence", () => {
    const events = parseIcsEvents(WEEKLY, RANGE);
    expect(events.map((event) => `${event.start.toISOString()} ${event.title}`)).toEqual([
      "2026-12-01T10:00:00.000Z Weekly sync",
      "2026-12-16T15:00:00.000Z Weekly sync (moved)",
      "2026-12-22T10:00:00.000Z Weekly sync",
      "2026-12-29T10:00:00.000Z Weekly sync",
    ]);
    expect(events[0]?.end?.toISOString()).toBe("2026-12-01T11:00:00.000Z");
  });

  it("skips a cancelled event and a cancelled occurrence", () => {
    const text = calendar(
      vevent(
        "UID:gone@test",
        "DTSTART:20261203T100000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Cancelled call",
      ),
      vevent("UID:kept@test", "DTSTART:20261204T100000Z", "SUMMARY:Kept call"),
      vevent(
        "UID:series@test",
        "DTSTART:20261207T100000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Daily",
      ),
      vevent(
        "UID:series@test",
        "RECURRENCE-ID:20261208T100000Z",
        "DTSTART:20261208T100000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Daily",
      ),
    );
    expect(
      parseIcsEvents(text, RANGE).map(
        (event) => `${event.start.toISOString().slice(0, 10)} ${event.title}`,
      ),
    ).toEqual(["2026-12-04 Kept call", "2026-12-07 Daily", "2026-12-09 Daily"]);
  });

  it("keeps an all-day event as a date, and only what falls in the window", () => {
    const text = calendar(
      vevent(
        "UID:trip@test",
        "DTSTART;VALUE=DATE:20261220",
        "DTEND;VALUE=DATE:20261223",
        "SUMMARY:Trip",
      ),
      vevent("UID:old@test", "DTSTART:20200101T100000Z", "SUMMARY:Long ago"),
    );
    const events = parseIcsEvents(text, RANGE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ allDay: true, title: "Trip" });
    expect(events[0]?.start.toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(events[0]?.end?.toISOString()).toBe("2026-12-23T00:00:00.000Z");
  });

  it("reads a zone from its VTIMEZONE, and cleans control characters out of titles", () => {
    const text = calendar(
      [
        "BEGIN:VTIMEZONE",
        "TZID:Test/Plus2",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0200",
        "END:STANDARD",
        "END:VTIMEZONE",
      ].join("\r\n"),
      vevent("UID:z@test", "DTSTART;TZID=Test/Plus2:20261210T120000", "SUMMARY:Zoned\u0007 call"),
    );
    const [event] = parseIcsEvents(text, RANGE);
    expect(event?.start.toISOString()).toBe("2026-12-10T10:00:00.000Z");
    expect(event?.title).toBe("Zoned  call");
  });

  it("throws on text that isn't iCalendar", () => {
    expect(() => parseIcsEvents("not a calendar at all", RANGE)).toThrow();
  });

  it("matches an attendee email to a client, ignoring case, and stores no email", async () => {
    serveFeed(
      calendar(
        vevent(
          "UID:m1@test",
          "DTSTART:20261210T100000Z",
          "SUMMARY:Kick-off",
          "ATTENDEE;CN=Client:mailto:Client-A@Example.Test",
          "ORGANIZER:mailto:someone@else.test",
        ),
        vevent(
          "UID:m2@test",
          "DTSTART:20261211T100000Z",
          "SUMMARY:Dentist",
          "ATTENDEE:mailto:stranger@elsewhere.test",
        ),
      ),
    );
    await add();
    const items = await as((db) =>
      calendarItems(db, { ...{ from: "2026-12-01", to: "2026-12-31" }, zone: "UTC" }),
    );
    const imported = items.filter((item) => item.type === "imported");
    expect(imported.find((item) => item.title === "Kick-off")).toMatchObject({
      isClientMeeting: true,
      clientId: USER_A.rows.clients,
      editable: false,
      sourceName: "Work (Google)",
    });
    expect(imported.find((item) => item.title === "Dentist")).toMatchObject({
      isClientMeeting: false,
      clientId: null,
    });
    const { rows } = await handle.db.query("SELECT * FROM public.calendar_events");
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("example.test");
    expect(JSON.stringify(rows)).not.toContain("elsewhere.test");
  });
});

describe("the secret address (A-S4)", () => {
  it("is never returned by any API, only its host, and is stored encrypted", async () => {
    serveFeed(WEEKLY);
    const { response, body } = await add();
    expect(response.status).toBe(201);
    const seen = [await response.clone().text()];
    const id = body.source.id;
    const ctx = { params: Promise.resolve({ id }) };
    const list = await handlers().list();
    seen.push(await list.text());
    const patch = await handlers().update(
      new Request("http://x.test", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color: "green" }),
      }),
      ctx,
    );
    seen.push(await patch.text());
    clock = new Date("2026-12-01T10:05:00Z");
    const refresh = await handlers().refresh(new Request("http://x.test", { method: "POST" }), ctx);
    seen.push(await refresh.text());
    const upload = await handlers().upload(
      new Request("http://x.test/api/calendar/sources/upload?name=File", {
        method: "PUT",
        body: WEEKLY,
      }),
    );
    seen.push(await upload.text());
    for (const text of seen) {
      expect(text).not.toContain(SECRET_PATH);
      expect(text).not.toContain("basic.ics");
      expect(text).not.toContain("url_enc");
    }
    expect(seen[1]).toContain("calendar.google.com");
    const { rows } = await handle.db.query<{ url_enc: string; url_host: string }>(
      "SELECT url_enc, url_host FROM public.calendar_sources WHERE kind = 'url'",
    );
    expect(rows[0]?.url_host).toBe("calendar.google.com");
    expect(rows[0]?.url_enc).not.toContain(SECRET_PATH);
    expect(box.decrypt(rows[0]?.url_enc ?? "", `calendar-source:${A}`)).toBe(FEED);
    expect(() => box.decrypt(rows[0]?.url_enc ?? "", `calendar-source:${USER_B.userId}`)).toThrow();
  });

  it("is never logged, on success or on failure", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    serveFeed(WEEKLY);
    const { body } = await add();
    server.resetHandlers();
    serveFeed("gone", 404);
    clock = new Date("2026-12-01T10:05:00Z");
    await handlers().refresh(new Request("http://x.test", { method: "POST" }), {
      params: Promise.resolve({ id: body.source.id }),
    });
    await handlers().add(
      new Request("http://x.test", json({ name: "Bad", url: "http://calendar.google.com/x" })),
    );
    expect(written.length).toBeGreaterThan(0);
    expect(written.join("")).not.toContain(SECRET_PATH);
    expect(written.join("")).not.toContain("calendar.google.com");
  });

  it("refuses an address that isn't https, or has a password, and doesn't repeat it", async () => {
    for (const url of [
      "http://calendar.google.com/x.ics",
      "https://user:hunter2@calendar.google.com/x.ics",
      "ftp://x.test/a.ics",
      "not an address",
    ]) {
      const response = await handlers().add(
        new Request("http://x.test", json({ name: "Bad", url })),
      );
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("x.test/a.ics");
    }
  });

  it("reads webcal:// as https://", async () => {
    serveFeed(WEEKLY);
    const response = await handlers().add(
      new Request(
        "http://x.test",
        json({ name: "Apple", url: FEED.replace("https://", "webcal://") }),
      ),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { sync: { ok: boolean } }).sync.ok).toBe(true);
  });
});

describe("connectivity (A-C1)", () => {
  it("syncs the events of a served calendar when it is added", async () => {
    serveFeed(WEEKLY);
    const { response, body } = await add();
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      sync: { ok: true, count: 4 },
      source: { eventCount: 4, lastError: null },
    });
    const items = await as((db) =>
      calendarItems(db, { from: "2026-12-01", to: "2026-12-31", zone: "UTC" }),
    );
    expect(items.filter((item) => item.type === "imported")).toHaveLength(4);
  });

  it("answers 404 with last_error http_error and keeps the old events", async () => {
    serveFeed(WEEKLY);
    const { body } = await add();
    server.resetHandlers();
    serveFeed("not found", 404);
    clock = new Date("2026-12-01T10:05:00Z");
    const refresh = await handlers().refresh(new Request("http://x.test", { method: "POST" }), {
      params: Promise.resolve({ id: body.source.id }),
    });
    expect(((await refresh.json()) as { sync: unknown }).sync).toEqual({
      ok: false,
      reason: "http_error",
    });
    const { rows } = await handle.db.query<{ last_error: string; event_count: number }>(
      "SELECT last_error, event_count FROM public.calendar_sources",
    );
    expect(rows[0]).toMatchObject({ last_error: "http_error", event_count: 4 });
    const stored = await handle.db.query("SELECT 1 FROM public.calendar_events");
    expect(stored.rows).toHaveLength(4);
  });

  it("refreshes a source at most once a minute", async () => {
    serveFeed(WEEKLY);
    const { body } = await add();
    const ctx = { params: Promise.resolve({ id: body.source.id }) };
    const tooSoon = await handlers().refresh(new Request("http://x.test", { method: "POST" }), ctx);
    expect(tooSoon.status).toBe(429);
    clock = new Date("2026-12-01T10:02:00Z");
    const later = await handlers().refresh(new Request("http://x.test", { method: "POST" }), ctx);
    expect(later.status).toBe(200);
  });

  it("refreshes due sources on schedule, once, as their own user", async () => {
    serveFeed(WEEKLY);
    await add();
    const sync = () =>
      runCalendarSync({
        ...deps(),
        runAsService: (work) => runAsService(handle.db, work),
        runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
        minutes: 30,
      });
    clock = new Date("2026-12-01T10:10:00Z");
    expect(await sync()).toEqual({ synced: 0, failed: 0 });
    clock = new Date("2026-12-01T10:45:00Z");
    expect(await sync()).toEqual({ synced: 1, failed: 0 });
    expect(await sync()).toEqual({ synced: 0, failed: 0 });
  });

  it("imports an uploaded file once, and refuses one that isn't a calendar", async () => {
    const good = await handlers().upload(
      new Request("http://x.test/api/calendar/sources/upload?name=Holidays", {
        method: "PUT",
        body: WEEKLY,
      }),
    );
    expect(good.status).toBe(201);
    expect(
      ((await good.json()) as { source: { kind: string; eventCount: number } }).source,
    ).toMatchObject({ kind: "file", eventCount: 4 });
    const bad = await handlers().upload(
      new Request("http://x.test/api/calendar/sources/upload?name=Nope", {
        method: "PUT",
        body: "<html></html>",
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("hides a switched-off calendar's events and removes them with the calendar", async () => {
    serveFeed(WEEKLY);
    const { body } = await add();
    const ctx = { params: Promise.resolve({ id: body.source.id }) };
    const range = { from: "2026-12-01", to: "2026-12-31", zone: "UTC" };
    await handlers().update(
      new Request("http://x.test", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      ctx,
    );
    expect(
      (await as((db) => calendarItems(db, range))).filter((item) => item.type === "imported"),
    ).toHaveLength(0);
    expect(
      (await handlers().remove(new Request("http://x.test", { method: "DELETE" }), ctx)).status,
    ).toBe(204);
    expect((await handle.db.query("SELECT 1 FROM public.calendar_events")).rows).toHaveLength(0);
  });
});

describe("the upload size limit", () => {
  it("stops reading a body with no declared length once it passes 2 MB", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 20) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request("http://x.test/api/calendar/sources/upload?name=Huge", {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit);
    const response = await handlers().upload(request);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(8);
  });
});
