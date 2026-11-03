import { z } from "zod";
import { baseUrlProblem } from "./ai-url";

// Server-only: one OpenAI-compatible chat call to the user's model. Every preset (and any
// local runner or the LiteLLM gateway) speaks this format, so nothing else changes with the
// model. The key goes only in the Authorization header, redirects are never followed, and
// neither the key nor the message text is ever logged or returned.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatTarget = {
  baseUrl: string;
  model: string;
  isLocal: boolean;
  apiKey: string | null;
};

export type ChatResult = { ok: true; text: string } | { ok: false; detail: string };

/** Local models can be slow on a laptop; cloud models answer well inside this. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const endpoint = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

const failure = (error: unknown): string => {
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "timed out";
  }
  return "couldn't connect";
};

export const chatCompletion = async (
  target: ChatTarget,
  messages: ChatMessage[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ChatResult> => {
  const problem = baseUrlProblem(target.baseUrl, target.isLocal);
  if (problem) return { ok: false, detail: `base URL ${problem}` };
  let response: Response;
  try {
    response = await fetch(endpoint(target.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      // No response_format: not every OpenAI-compatible server accepts it. The prompt asks for
      // JSON and the router checks it against the schema.
      body: JSON.stringify({ model: target.model, messages, temperature: 0 }),
    });
  } catch (error) {
    return { ok: false, detail: failure(error) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, detail: `HTTP ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "answer wasn't JSON" };
  }
  const parsed = completionSchema.safeParse(body);
  const text = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
  return text === undefined
    ? { ok: false, detail: "answer wasn't a chat completion" }
    : { ok: true, text };
};
