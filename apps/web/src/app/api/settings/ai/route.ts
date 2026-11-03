import { aiSettingsHandlers } from "@/lib/ai-settings-handlers";
import { secretBox } from "@/lib/crypto";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = aiSettingsHandlers({ runAsUser: runAsCurrentUser, box: secretBox });

export const GET = handlers.get;
export const PUT = handlers.save;
