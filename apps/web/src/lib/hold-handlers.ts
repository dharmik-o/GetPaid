import { z } from "zod";
import { captureHold, startHold, voidHold, type HoldDeps } from "./hold-flow";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import { PaypalError } from "./paypal";

// Server-only: POST /api/milestones/[id]/hold, as the signed-in freelancer. Starting makes a PayPal
// order and an email draft. Capture needs the milestone Accepted. Void releases the money.

type Deps = HoldDeps & { currentUser: () => string };
type IdContext = { params: Promise<{ id: string }> };

const MILESTONE = "Milestone";

const actionSchema = z.strictObject({
  action: z.enum(["start", "capture", "void"], { error: "must be start, capture or void" }),
});

const CAPTURE_ANSWERS: Readonly<Record<string, { status: number; error: string } | undefined>> = {
  no_hold: { status: 409, error: "There's no authorized hold to capture." },
  not_accepted: {
    status: 409,
    error: "Mark the milestone Accepted first: that's what captures it.",
  },
  expired: {
    status: 409,
    error:
      "This hold expired after 29 days, so nothing was taken. Start a new one, or change how it's paid.",
  },
  denied: { status: 502, error: "PayPal denied the capture, so nothing was taken." },
};

export const holdHandlers = (deps: Deps) => ({
  act: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id: milestoneId } = await params;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = actionSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const target = { userId: deps.currentUser(), milestoneId };
    try {
      switch (parsed.data.action) {
        case "start": {
          const result = await startHold(deps, target);
          if (result.status === "not_found") return notFound(MILESTONE);
          if (result.status === "conflict") return jsonResponse({ error: result.message }, 409);
          return jsonResponse({ warning: result.warning }, result.status === "started" ? 201 : 200);
        }
        case "capture": {
          const result = await captureHold(deps, target);
          if (result.status === "refused") return jsonResponse({ error: result.message }, 502);
          const answer = CAPTURE_ANSWERS[result.status];
          return answer
            ? jsonResponse({ error: answer.error }, answer.status)
            : jsonResponse({ status: result.status });
        }
        case "void": {
          const result = await voidHold(deps, target);
          if (result.status === "not_found") return notFound(MILESTONE);
          if (result.status === "conflict") return jsonResponse({ error: result.message }, 409);
          return jsonResponse({ status: "voided" });
        }
      }
    } catch (error) {
      if (error instanceof PaypalError) {
        logEvent("holds.paypal_failed", { status: error.status, issue: error.issue });
        return jsonResponse({ error: error.message }, 502);
      }
      return serverError("holds.action_failed", error);
    }
  },
});
