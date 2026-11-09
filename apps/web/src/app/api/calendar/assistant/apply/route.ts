import { calendarAssistantHandlers } from "@/lib/calendar-assistant-handlers";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = calendarAssistantHandlers({
  runAsUser: runAsCurrentUser,
  box: secretBox,
  now: () => appNow(),
});

export const POST = handlers.apply;
