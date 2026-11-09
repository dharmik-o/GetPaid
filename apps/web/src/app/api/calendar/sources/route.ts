import { calendarSourceHandlers } from "@/lib/calendar-source-handlers";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = calendarSourceHandlers({
  runAsUser: runAsCurrentUser,
  box: secretBox,
  now: () => appNow(),
});

export const GET = handlers.list;
export const POST = handlers.add;
