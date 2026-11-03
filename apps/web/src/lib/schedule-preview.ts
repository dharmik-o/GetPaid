import { formatDateTime, formatDay } from "./format";
import { computeDueDate, nextSend, startOfLocalDay, type NextSend } from "./schedule";
import type { ScheduleSettings } from "./settings";

// The live preview line under ScheduleForm. All timing comes from lib/schedule.ts.
// Pure: safe in client components.

type PreviewContext = { deadline: string; timeZone: string };

const atClientTime = (sendAt: Date, timeZone: string): string =>
  `${formatDateTime(sendAt, timeZone)} client time`;

const cadence = (settings: ScheduleSettings): string =>
  settings.interval.kind === "every"
    ? `every ${String(settings.interval.days)} day${settings.interval.days === 1 ? "" : "s"}`
    : "on the dates you picked";

const scheduledAt = (plan: NextSend): Date | undefined =>
  plan.status === "scheduled" ? plan.sendAt : undefined;

/** One paragraph, assuming the invoice goes out on the delivery deadline. */
export const describeSchedule = (settings: ScheduleSettings, context: PreviewContext): string => {
  if (!context.deadline || !context.timeZone) {
    return "Add a deadline and a client to see when reminders go out.";
  }
  if (settings.paused) return "Reminders are paused. Nothing is sent until you resume them.";

  const dueDate = computeDueDate(settings.paymentTerms, context.deadline);
  const invoicedAt = startOfLocalDay(context.deadline, context.timeZone);
  const base = { settings, dueDate, timeZone: context.timeZone };

  const first = nextSend({ ...base, history: [], now: invoicedAt });
  const courtesy = first.status === "scheduled" && first.tier === "courtesy" ? first : undefined;
  const reminder = courtesy
    ? nextSend({
        ...base,
        history: [{ tier: "courtesy", at: courtesy.sendAt }],
        now: courtesy.sendAt,
      })
    : first;

  const parts = [
    `If you invoice on ${formatDay(context.deadline)}, payment is due ${formatDay(dueDate)}.`,
  ];
  if (courtesy) parts.push(`Courtesy note: ${atClientTime(courtesy.sendAt, context.timeZone)}.`);
  const reminderAt = scheduledAt(reminder);
  if (reminderAt) {
    parts.push(
      `First reminder: ${atClientTime(reminderAt, context.timeZone)}, then ${cadence(settings)}.`,
    );
  }
  return parts.join(" ");
};
