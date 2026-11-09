import { calendarSyncHandler } from "@/lib/calendar-sync-handler";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { calendarSyncMinutes, internalApiToken } from "@/lib/env";
import { withServiceDb } from "@/lib/service-db";

// Called by n8n's 08_calendar_sync only (Bearer INTERNAL_API_TOKEN). The service role only finds what
// is due; each sync then reads and writes as that freelancer (RLS).
const handler = calendarSyncHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  now: () => appNow(),
  box: secretBox,
  minutes: calendarSyncMinutes(),
  token: () => internalApiToken(),
});

export const POST = handler.post;
