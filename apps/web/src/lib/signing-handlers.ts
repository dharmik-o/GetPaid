import { sha256Hex } from "./agreement-email";
import { loadForSigning, respondToAgreement, type SigningDeps } from "./agreement-signing";
import { jsonResponse, readJson, serverError } from "./http";
import { createWindowLimiter, type WindowLimiter } from "./rate-window";

// Server-only: GET and POST /api/sign/[token], the public signing API. No login: the token is the
// credential. Rate-limited per address and per token, and every bad token answers the same 404.

export type SigningLimits = { ip: WindowLimiter; token: WindowLimiter };

export const createSigningLimits = (): SigningLimits => ({
  ip: createWindowLimiter(10, 60 * 1000),
  token: createWindowLimiter(20, 60 * 60 * 1000),
});

type Deps = SigningDeps & { limits: SigningLimits };
type TokenContext = { params: Promise<{ token: string }> };

/** The caller's address: the first x-forwarded-for value (Caddy sets it), or "unknown". */
export const clientAddress = (headers: Headers): string => {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : "unknown";
};

/** Counts this request against both limits (always both) and says whether it may go on. */
export const withinLimits = (
  limits: SigningLimits,
  address: string,
  token: string,
  nowMs: number,
): boolean => {
  const byAddress = limits.ip.allow(address, nowMs);
  const byToken = limits.token.allow(sha256Hex(token), nowMs);
  return byAddress && byToken;
};

const TOO_MANY = () =>
  jsonResponse({ error: "Too many requests. Wait a minute and try again." }, 429);

/** The one answer for a wrong, unknown, used, expired or wrong-status token. */
const NOT_VALID = () => jsonResponse({ error: "This signing link isn't valid." }, 404);

export const signingHandlers = (deps: Deps) => {
  const blocked = (request: Request, token: string): boolean =>
    !withinLimits(deps.limits, clientAddress(request.headers), token, deps.now().getTime());

  return {
    get: async (request: Request, { params }: TokenContext): Promise<Response> => {
      const { token } = await params;
      if (blocked(request, token)) return TOO_MANY();
      try {
        const view = await loadForSigning(deps, token);
        return view ? jsonResponse(view) : NOT_VALID();
      } catch (error) {
        return serverError("sign.view_failed", error);
      }
    },

    post: async (request: Request, { params }: TokenContext): Promise<Response> => {
      const { token } = await params;
      if (blocked(request, token)) return TOO_MANY();
      const body = await readJson(request);
      if (!body.ok) return body.response;
      try {
        const outcome = await respondToAgreement(deps, token, body.body, {
          ip: clientAddress(request.headers),
          userAgent: (request.headers.get("user-agent") ?? "unknown").slice(0, 400),
        });
        switch (outcome.status) {
          case "signed":
          case "declined":
            return jsonResponse({ status: outcome.status });
          case "invalid":
            return jsonResponse(
              {
                error: "Some fields need fixing. Check the messages and try again.",
                errors: outcome.errors,
              },
              400,
            );
          case "conflict":
            return jsonResponse({ error: outcome.message }, 409);
          case "not_found":
            return NOT_VALID();
        }
      } catch (error) {
        return serverError("sign.respond_failed", error);
      }
    },
  };
};
