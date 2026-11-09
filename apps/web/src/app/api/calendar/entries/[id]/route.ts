import { calendarHandlers } from "@/lib/calendar-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = calendarHandlers({ runAsUser: runAsCurrentUser });

export const PATCH = handlers.updateEntry;
export const DELETE = handlers.deleteEntry;
