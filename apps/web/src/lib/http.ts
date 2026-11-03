import type { FieldIssue } from "./field-issues";
import { errorKind, logEvent } from "./log";

// Server-only response helpers for route handlers. Error bodies say what failed and what to do.

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

export const noContent = (): Response => new Response(null, { status: 204 });

export const fieldErrors = (errors: FieldIssue[]): Response =>
  jsonResponse(
    { error: "Some fields need fixing. Check the messages and try again.", errors },
    400,
  );

export const notFound = (what: string): Response =>
  jsonResponse(
    {
      error: `${what} not found. It may have been deleted; go back to the list and pick it again.`,
    },
    404,
  );

/** Logs the failure without its message (which can hold user data) and returns a generic 500. */
export const serverError = (event: string, error: unknown): Response => {
  logEvent(event, { error: errorKind(error) });
  return jsonResponse(
    {
      error:
        "Something went wrong on our side. Try again; if it keeps failing, check the server log.",
    },
    500,
  );
};

export type JsonBody = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON body. Requiring `application/json` also means a cross-site page can't
 * post here with a plain form: the browser would have to ask first (CORS preflight).
 */
export const readJson = async (request: Request): Promise<JsonBody> => {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "Send the request body as JSON (Content-Type: application/json)." },
        415,
      ),
    };
  }
  try {
    return { ok: true, body: (await request.json()) as unknown };
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "The request body isn't valid JSON. Fix it and send again." },
        400,
      ),
    };
  }
};
