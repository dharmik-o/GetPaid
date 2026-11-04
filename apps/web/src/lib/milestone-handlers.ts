import { isUuid, type UserDbRunner } from "./db";
import { captureHold, type HoldDeps } from "./hold-flow";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { errorKind, logEvent } from "./log";
import { markMilestoneStatus, saveMilestonePlan } from "./milestones";

// Server-only: PUT /api/projects/[id]/milestones and PATCH /api/milestones/[id].
// `runAsUser` is injected so tests can use an in-memory database with real RLS.

/** What acceptance needs to capture a hold; tests of other things leave it out. */
type HoldAccess = HoldDeps & { currentUser: () => string };
type Deps = { runAsUser: UserDbRunner; holds?: HoldAccess };
type IdContext = { params: Promise<{ id: string }> };

/**
 * Capture on acceptance. The acceptance itself stands whatever PayPal says: a refusal is reported,
 * and the scheduler keeps trying while the hold lasts.
 */
const captureOnAcceptance = async (
  holds: HoldAccess,
  milestoneId: string,
): Promise<string | undefined> => {
  try {
    const result = await captureHold(holds, { userId: holds.currentUser(), milestoneId });
    return result.status === "refused" ? result.message : undefined;
  } catch (error) {
    logEvent("milestones.capture_failed", { milestoneId, error: errorKind(error) });
    return "PayPal couldn't be reached for the capture. It tries again each hour.";
  }
};

export const milestoneHandlers = ({ runAsUser, holds }: Deps) => ({
  savePlan: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Project");
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => saveMilestonePlan(db, id, body.body));
      if (result.ok) {
        logEvent("milestones.plan_saved", { projectId: id, count: result.milestones.length });
        return jsonResponse({ milestones: result.milestones, warnings: result.warnings });
      }
      return "notFound" in result ? notFound("Project") : fieldErrors(result.errors);
    } catch (error) {
      return serverError("milestones.plan_failed", error);
    }
  },

  markStatus: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Milestone");
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => markMilestoneStatus(db, id, body.body));
      if (result.ok) {
        logEvent("milestones.status_changed", { milestoneId: id, status: result.milestone.status });
        const holdError =
          holds && result.milestone.status === "accepted" && result.milestone.paymentMode === "hold"
            ? await captureOnAcceptance(holds, id)
            : undefined;
        return jsonResponse({ milestone: result.milestone, ...(holdError ? { holdError } : {}) });
      }
      return "notFound" in result ? notFound("Milestone") : fieldErrors(result.errors);
    } catch (error) {
      return serverError("milestones.status_failed", error);
    }
  },
});
