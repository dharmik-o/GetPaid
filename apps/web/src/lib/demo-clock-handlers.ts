import { z } from "zod";
import { MAX_OFFSET_DAYS, setDemoOffsetDays } from "./clock";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson } from "./http";

// POST /api/dev/clock: jumps the demo clock without a restart. Development only; in production the
// route doesn't exist as far as anyone can tell.

const bodySchema = z.strictObject({
  days: z
    .number({ error: "must be a number" })
    .min(0, { error: "can't be negative" })
    .max(MAX_OFFSET_DAYS, { error: `must be ${String(MAX_OFFSET_DAYS)} or fewer` }),
});

type Deps = { env?: Partial<Record<"NODE_ENV" | "DEMO_CLOCK_OFFSET_DAYS", string>> };

export const demoClockHandlers = ({ env = process.env }: Deps = {}) => ({
  post: async (request: Request): Promise<Response> => {
    if (env.NODE_ENV === "production") return notFound("This page");
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = bodySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
    setDemoOffsetDays(parsed.data.days, env);
    return jsonResponse({ days: parsed.data.days });
  },
});
