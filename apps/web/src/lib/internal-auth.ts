import { createHash, timingSafeEqual } from "node:crypto";
import { jsonResponse } from "./http";
import { logEvent } from "./log";

// Server-only: the check on every n8n-facing endpoint. n8n proves itself with a Bearer
// INTERNAL_API_TOKEN, compared in constant time. Returns the refusal, or undefined to go on.

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

const authorized = (request: Request, expected: string): boolean => {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return given !== "" && timingSafeEqual(digest(given), digest(expected));
};

export const refuseUnlessInternal = (
  request: Request,
  expected: string | undefined,
  event: string,
): Response | undefined => {
  if (!expected) {
    logEvent(event, { reason: "token_not_configured" });
    return jsonResponse(
      {
        error: "This endpoint isn't set up: set INTERNAL_API_TOKEN (see .env.example) and restart.",
      },
      503,
    );
  }
  if (!authorized(request, expected)) {
    logEvent(event, { reason: "bad_token" });
    return jsonResponse({ error: "Not authorized. Check the n8n credential's token." }, 401);
  }
  return undefined;
};
