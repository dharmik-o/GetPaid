import { jsonResponse, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { runScheduler, type SchedulerDeps } from "./scheduler";

// Server-only: POST /api/internal/scheduler/run, which n8n's 01_scheduler calls hourly with its
// token. Safe to repeat: an invoice has at most one reminder in progress.

export const schedulerHandler = (deps: SchedulerDeps & { token: () => string | undefined }) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "scheduler.rejected");
    if (refused) return refused;
    try {
      return jsonResponse(await runScheduler(deps));
    } catch (error) {
      return serverError("scheduler.failed", error);
    }
  },
});
