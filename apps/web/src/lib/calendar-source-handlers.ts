import {
  addFileSource,
  addSource,
  listSources,
  MAX_FILE_BYTES,
  parseFileSource,
  parseSourceAdd,
  refreshSource,
  removeSource,
  updateSource,
  type ImportDeps,
  type SyncResult,
} from "./calendar-import";
import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: the /api/calendar/sources route handlers. The secret address goes in once (POST) and is
// never returned: every answer carries only the host. Nothing here logs an address, a name or a
// file's text, only ids, counts and reason codes.

type Deps = { runAsUser: UserDbRunner } & ImportDeps;
type IdContext = { params: Promise<{ id: string }> };

const SOURCE = "Calendar source";
const TOO_BIG = `That file is too large. Calendar files must be ${String(MAX_FILE_BYTES / 1024 / 1024)} MB or smaller.`;

/** The body as text, or null once it passes the limit: stops reading then, whatever the declared length. */
const readLimited = async (request: Request): Promise<string | null> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const syncBody = (result: SyncResult) =>
  result.ok ? { ok: true, count: result.count } : { ok: false, reason: result.reason };

export const calendarSourceHandlers = (deps: Deps) => {
  const { runAsUser } = deps;
  return {
    list: async (): Promise<Response> => {
      try {
        return jsonResponse({ sources: await runAsUser((db) => listSources(db)) });
      } catch (error) {
        return serverError("calendar_sources.list_failed", error);
      }
    },

    add: async (request: Request): Promise<Response> => {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const parsed = parseSourceAdd(body.body);
      if (!parsed.ok) return fieldErrors(parsed.errors);
      try {
        const result = await runAsUser((db) => addSource(db, parsed.value, deps));
        if (!result.ok) return fieldErrors(result.errors);
        logEvent("calendar_sources.added", {
          sourceId: result.source.id,
          synced: result.sync.ok,
        });
        return jsonResponse({ source: result.source, sync: syncBody(result.sync) }, 201);
      } catch (error) {
        return serverError("calendar_sources.add_failed", error);
      }
    },

    upload: async (request: Request): Promise<Response> => {
      const params = new URL(request.url).searchParams;
      const parsed = parseFileSource(params.get("name"), params.get("color"));
      if (!parsed.ok) return fieldErrors(parsed.errors);
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_FILE_BYTES) return jsonResponse({ error: TOO_BIG }, 413);
      try {
        const text = await readLimited(request);
        if (text === null) return jsonResponse({ error: TOO_BIG }, 413);
        const result = await runAsUser((db) => addFileSource(db, { ...parsed.value, text }, deps));
        if (!result.ok) return fieldErrors(result.errors);
        logEvent("calendar_sources.uploaded", {
          sourceId: result.source.id,
          count: result.source.eventCount,
        });
        return jsonResponse({ source: result.source }, 201);
      } catch (error) {
        return serverError("calendar_sources.upload_failed", error);
      }
    },

    update: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(SOURCE);
      const body = await readJson(request);
      if (!body.ok) return body.response;
      try {
        const result = await runAsUser((db) => updateSource(db, id, body.body));
        if (!result) return notFound(SOURCE);
        if (!result.ok) return fieldErrors(result.errors);
        logEvent("calendar_sources.updated", { sourceId: id });
        return jsonResponse({ source: result.value });
      } catch (error) {
        return serverError("calendar_sources.update_failed", error);
      }
    },

    /** "Refresh now": at most once a minute per source. */
    refresh: async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(SOURCE);
      try {
        const result = await runAsUser((db) => refreshSource(db, id, deps));
        if (!result) return notFound(SOURCE);
        if (!result.ok && result.reason === "too_soon") {
          return jsonResponse(
            { error: "That calendar was refreshed a moment ago. Wait a minute and try again." },
            429,
          );
        }
        logEvent("calendar_sources.refreshed", { sourceId: id, synced: result.ok });
        return jsonResponse({ sync: syncBody(result) });
      } catch (error) {
        return serverError("calendar_sources.refresh_failed", error);
      }
    },

    remove: async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(SOURCE);
      try {
        if (!(await runAsUser((db) => removeSource(db, id)))) return notFound(SOURCE);
        logEvent("calendar_sources.removed", { sourceId: id });
        return noContent();
      } catch (error) {
        return serverError("calendar_sources.remove_failed", error);
      }
    },
  };
};
