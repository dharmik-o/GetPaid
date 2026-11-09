import { runCalendarSync, type CalendarSyncDeps } from "./calendar-sync";
import { jsonResponse, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { logEvent } from "./log";

// Server-only: POST /api/internal/calendar/sync, which n8n's 08_calendar_sync calls with its token.
// Safe to repeat: a source that was just synced or is being synced isn't touched again.

export const calendarSyncHandler = (
  deps: CalendarSyncDeps & { token: () => string | undefined },
) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "calendar_sync.rejected");
    if (refused) return refused;
    try {
      const result = await runCalendarSync(deps);
      logEvent("calendar_sync.run", result);
      return jsonResponse(result);
    } catch (error) {
      return serverError("calendar_sync.failed", error);
    }
  },
});
