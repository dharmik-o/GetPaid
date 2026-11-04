import { appNow, demoOffsetDays } from "@/lib/clock";
import { formatDay } from "@/lib/format";

// Shown on every page while the demo clock is moved, so nobody mistakes the dates for real ones.

type Props = { env?: Parameters<typeof demoOffsetDays>[0]; real?: Date };

export const DemoClockBanner = ({ env = process.env, real = new Date() }: Props) => {
  const days = demoOffsetDays(env);
  if (days === 0) return null;
  const today = formatDay(appNow(env, real).toISOString().slice(0, 10));
  return (
    <p className="banner demo-clock" role="status">
      Demo clock: {days} {days === 1 ? "day" : "days"} ahead. Today here is {today} (UTC).
    </p>
  );
};
