import { calendarHandlers } from "@/lib/calendar-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = calendarHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.items;
