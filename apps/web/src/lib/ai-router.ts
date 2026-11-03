import type { z } from "zod";
import { chatCompletion, DEFAULT_TIMEOUT_MS, type ChatMessage } from "./ai-client";
import type { AiConnection } from "./ai-settings";

// Server-only: the AI router. Order: local models first, then a cloud model only if the user
// added one as a fallback, then the caller's fixed template. Every answer must match the
// schema; an invalid one is retried once on the same model, and then the template is used (a
// draft that fails the schema is never used). With no template, the caller waits.

export type Attempt = {
  provider: string;
  model: string;
  isLocal: boolean;
  outcome: "ok" | "invalid" | "unavailable";
  /** Short and safe to show: "HTTP 401", "timed out", "not valid JSON". Never message text. */
  detail: string;
  ms: number;
};

export type RouteRequest<T> = {
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** Used when no model gives a valid answer. Must match the schema. */
  template?: T;
};

export type RouteResult<T> =
  | {
      ok: true;
      via: "model";
      output: T;
      provider: string;
      model: string;
      isLocal: boolean;
      attempts: Attempt[];
    }
  | { ok: true; via: "template"; output: T; attempts: Attempt[] }
  | { ok: false; reason: "unavailable" | "invalid"; attempts: Attempt[] };

const RETRY_REMINDER: ChatMessage = {
  role: "user",
  content:
    "Your last answer didn't match the required format. Reply with only the JSON object described above: no other text, no code fence.",
};

/** The JSON object in a model's answer, allowing a code fence or text around it. */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

type Outcome<T> = { kind: "ok"; output: T } | { kind: "invalid" } | { kind: "unavailable" };

/** One model: one call, and one retry if the answer is invalid. */
const tryModel = async <T>(
  connection: AiConnection,
  request: RouteRequest<T>,
  timeoutMs: number,
  attempts: Attempt[],
): Promise<Outcome<T>> => {
  for (const retry of [false, true]) {
    const started = Date.now();
    const messages = retry ? [...request.messages, RETRY_REMINDER] : request.messages;
    const answer = await chatCompletion(connection, messages, timeoutMs);
    const record = (outcome: Attempt["outcome"], detail: string) => {
      attempts.push({
        provider: connection.provider,
        model: connection.model,
        isLocal: connection.isLocal,
        outcome,
        detail,
        ms: Date.now() - started,
      });
    };
    if (!answer.ok) {
      record("unavailable", answer.detail);
      return { kind: "unavailable" };
    }
    const parsed = request.schema.safeParse(extractJson(answer.text));
    if (parsed.success) {
      record("ok", "valid");
      return { kind: "ok", output: parsed.data };
    }
    record("invalid", "didn't match the schema");
  }
  return { kind: "invalid" };
};

/** Local models first, then cloud, each in the order the user saved them. */
const inOrder = (connections: AiConnection[]): AiConnection[] => [
  ...connections.filter((c) => c.isLocal).sort((a, b) => a.order - b.order),
  ...connections.filter((c) => !c.isLocal).sort((a, b) => a.order - b.order),
];

export const routeTask = async <T>(
  connections: AiConnection[],
  request: RouteRequest<T>,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<RouteResult<T>> => {
  if (request.template !== undefined && !request.schema.safeParse(request.template).success) {
    throw new Error("The fallback template doesn't match the schema. Fix the template in code.");
  }
  const attempts: Attempt[] = [];
  const fallback = (reason: "unavailable" | "invalid"): RouteResult<T> =>
    request.template === undefined
      ? { ok: false, reason, attempts }
      : { ok: true, via: "template", output: request.template, attempts };

  for (const connection of inOrder(connections)) {
    const outcome = await tryModel(connection, request, timeoutMs, attempts);
    if (outcome.kind === "ok") {
      return {
        ok: true,
        via: "model",
        output: outcome.output,
        provider: connection.provider,
        model: connection.model,
        isLocal: connection.isLocal,
        attempts,
      };
    }
    // Invalid twice: the template, not another model (the spec's retry-once rule).
    if (outcome.kind === "invalid") return fallback("invalid");
  }
  return fallback("unavailable");
};
