import { getOwnTimeZone } from "./account";
import {
  createEntry,
  deleteEntry,
  markEntryDone,
  parseEntryInput,
  updateEntry,
} from "./calendar-entries";
import { calendarItems, MAX_RANGE_DAYS, validRange } from "./calendar-feed";
import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: the /api/calendar route handlers. `runAsUser` is injected so tests can drive the same
// code against an in-memory database with real row-level security.

type Deps = { runAsUser: UserDbRunner };
type IdContext = { params: Promise<{ id: string }> };

const ENTRY = "Calendar entry";

export const calendarHandlers = ({ runAsUser }: Deps) => ({
  items: async (request: Request): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (!validRange(from, to)) {
      return fieldErrors([
        {
          field: "from",
          message: `and to must be dates like 2026-12-31, with to no more than ${String(MAX_RANGE_DAYS)} days after from`,
        },
      ]);
    }
    try {
      const items = await runAsUser(async (db) =>
        calendarItems(db, { from, to, zone: await getOwnTimeZone(db) }),
      );
      return jsonResponse({ items });
    } catch (error) {
      return serverError("calendar.list_failed", error);
    }
  },

  createEntry: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser(async (db) => {
        const parsed = parseEntryInput(body.body, await getOwnTimeZone(db));
        return parsed.ok ? createEntry(db, parsed.value) : parsed;
      });
      if (!result.ok) return fieldErrors(result.errors);
      logEvent("calendar.entry_created", { entryId: result.entry.id });
      return jsonResponse({ entry: result.entry }, 201);
    } catch (error) {
      return serverError("calendar.create_failed", error);
    }
  },

  /** `{ "done": true | false }` marks an entry done or open; any other fields change the entry. */
  updateEntry: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(ENTRY);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const patch = body.body;
    const doneOnly =
      patch !== null &&
      typeof patch === "object" &&
      "done" in patch &&
      Object.keys(patch).length === 1;
    try {
      if (doneOnly && typeof patch.done === "boolean") {
        const done = patch.done;
        const entry = await runAsUser((db) => markEntryDone(db, id, done));
        if (!entry) return notFound(ENTRY);
        logEvent("calendar.entry_updated", { entryId: id });
        return jsonResponse({ entry });
      }
      const result = await runAsUser((db) => updateEntry(db, id, patch));
      if (!result) return notFound(ENTRY);
      if (!result.ok) return fieldErrors(result.errors);
      logEvent("calendar.entry_updated", { entryId: id });
      return jsonResponse({ entry: result.entry });
    } catch (error) {
      return serverError("calendar.update_failed", error);
    }
  },

  deleteEntry: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(ENTRY);
    try {
      if (!(await runAsUser((db) => deleteEntry(db, id)))) return notFound(ENTRY);
      logEvent("calendar.entry_deleted", { entryId: id });
      return noContent();
    } catch (error) {
      return serverError("calendar.delete_failed", error);
    }
  },
});
