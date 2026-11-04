import { jsonResponse, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { runSender, type SenderDeps } from "./sender";

// Server-only: POST /api/internal/sender/run, which n8n's 04_sender calls every minute with its
// token. Safe to repeat: a reminder that's claimed or sent isn't touched again.

export const senderHandler = (deps: SenderDeps & { token: () => string | undefined }) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "sender.rejected");
    if (refused) return refused;
    try {
      return jsonResponse(await runSender(deps));
    } catch (error) {
      return serverError("sender.failed", error);
    }
  },
});
