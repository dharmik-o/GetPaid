import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import { markMilestoneStatus, saveMilestonePlan } from "./milestones";

// Server-only: PUT /api/projects/[id]/milestones and PATCH /api/milestones/[id].
// `runAsUser` is injected so tests can use an in-memory database with real RLS.

type Deps = { runAsUser: UserDbRunner };
type IdContext = { params: Promise<{ id: string }> };

export const milestoneHandlers = ({ runAsUser }: Deps) => ({
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
        return jsonResponse({ milestone: result.milestone });
      }
      return "notFound" in result ? notFound("Milestone") : fieldErrors(result.errors);
    } catch (error) {
      return serverError("milestones.status_failed", error);
    }
  },
});
