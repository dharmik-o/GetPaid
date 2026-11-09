import type { Db } from "./db";
import type { TelegramOp } from "./telegram-card";
import { localTimeInput, todayIn } from "./schedule";

// Server-only, run by the Telegram step (service role, like the other steps there): the morning nudge
// for calendar entries that asked for one. Each entry is told once, on its day, after 09:00 in its own
// zone. Moving an entry to another day clears the mark so it can nudge again.

const NUDGE_HOUR = 9;

type NudgeRow = {
  id: string;
  title: string;
  starts_on: string;
  time_zone: string;
  client_name: string | null;
  chat_id: string;
};

export const calendarNudges = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<NudgeRow>(
    `SELECT e.id::text, e.title, e.starts_on::text, e.time_zone, c.name AS client_name,
       u.telegram_chat_id::text AS chat_id
     FROM public.calendar_entries e
     JOIN public.users u ON u.id = e.user_id
     LEFT JOIN public.clients c ON c.id = e.client_id
     WHERE e.remind_on_day AND e.status = 'open' AND e.telegram_notified_at IS NULL
       AND u.telegram_chat_id IS NOT NULL
       AND e.starts_on BETWEEN ($1::timestamptz AT TIME ZONE 'UTC')::date - 1
                           AND ($1::timestamptz AT TIME ZONE 'UTC')::date + 1
     ORDER BY e.starts_on, e.created_at LIMIT 50`,
    [now.toISOString()],
  );
  const due = rows.filter(
    (row) =>
      todayIn(now, row.time_zone) === row.starts_on &&
      Number(localTimeInput(now, row.time_zone).slice(11, 13)) >= NUDGE_HOUR,
  );
  if (due.length === 0) return [];
  await db.query(
    "UPDATE public.calendar_entries SET telegram_notified_at = $1 WHERE id = ANY($2::uuid[])",
    [now.toISOString(), due.map((row) => row.id)],
  );
  return due.map((row) => ({
    op: "sendText",
    chatId: Number(row.chat_id),
    text: `Today: ${row.title}${row.client_name ? ` (${row.client_name})` : ""}`,
  }));
};
