import { z } from "zod";
import { logEvent } from "./log";

// Server-only: the local model runner (Ollama). The app never controls Docker (decision E2); it
// only asks Ollama's own API what it has (`/api/tags`) and to download a model (`/api/pull`).

const DEFAULT_URL = "http://127.0.0.1:11434";
const CHECK_TIMEOUT_MS = 2000;

/** The Ollama address from LOCAL_AI_URL, without a trailing slash. */
export const localAiUrl = (source: Record<string, string | undefined> = process.env): string =>
  source.LOCAL_AI_URL?.trim().replace(/\/+$/, "") || DEFAULT_URL;

/** A model name Ollama accepts, e.g. `llama3.2`, `qwen2.5:3b`, `library/phi3:mini`. */
export const MODEL_NAME = /^[a-z0-9][a-z0-9._:/-]{0,80}$/;

/** Shown as one-click choices; sizes are approximate downloads. */
export const SUGGESTED_MODELS = [
  { name: "llama3.2", size: "about 2 GB" },
  { name: "qwen2.5:3b", size: "about 1.9 GB" },
] as const;

export type LocalAiStatus = { up: false } | { up: true; models: string[] };

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });

/** Is Ollama reachable, and which models does it have? Never throws. */
export const localAiStatus = async (base: string = localAiUrl()): Promise<LocalAiStatus> => {
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return { up: false };
    const parsed = tagsSchema.safeParse(await response.json());
    return parsed.success
      ? { up: true, models: parsed.data.models.map((m) => m.name) }
      : { up: false };
  } catch {
    return { up: false };
  }
};

export type PullJob = {
  model: string;
  state: "pulling" | "done" | "failed";
  /** Ollama's own words for the step, e.g. "pulling manifest"; or what went wrong. */
  message: string;
  completed: number;
  total: number;
};

const pullLineSchema = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
});

export type StartResult =
  { ok: true; job: PullJob } | { ok: false; reason: "busy" | "off" | "rejected" };

/**
 * One model download at a time per server. The job lives in memory: the page polls it, and a
 * restart forgets it (Ollama keeps what it already downloaded, so a second try resumes).
 */
export const createPuller = (base: () => string = localAiUrl) => {
  let job: PullJob | undefined;

  const run = async (current: PullJob, body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const apply = (line: string): void => {
      if (!line.trim()) return;
      const parsed = pullLineSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      const { status, error, completed, total } = parsed.data;
      if (error) {
        current.state = "failed";
        current.message = "Ollama couldn't download that model. Check the name and try again.";
      } else if (status === "success") {
        current.state = "done";
        current.message = "Downloaded.";
      } else if (status) {
        // shortcut: progress is the current layer's, not the whole model's; fine for a progress bar.
        current.message = status;
        current.completed = completed ?? 0;
        current.total = total ?? 0;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(apply);
    }
    apply(buffer);
    if (current.state === "pulling") {
      current.state = "failed";
      current.message = "The download stopped early. Try again; it resumes where it left off.";
    }
  };

  return {
    current: (): PullJob | undefined => job,

    start: async (model: string): Promise<StartResult> => {
      if (job?.state === "pulling") return { ok: false, reason: "busy" };
      const next: PullJob = {
        model,
        state: "pulling",
        message: "starting",
        completed: 0,
        total: 0,
      };
      let response: Response;
      try {
        response = await fetch(`${base()}/api/pull`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, stream: true }),
        });
      } catch {
        return { ok: false, reason: "off" };
      }
      if (!response.ok || !response.body) {
        return { ok: false, reason: response.status >= 500 ? "off" : "rejected" };
      }
      job = next;
      logEvent("local_ai.pull_started", {});
      run(next, response.body).catch(() => {
        next.state = "failed";
        next.message = "The download stopped early. Try again; it resumes where it left off.";
      });
      return { ok: true, job: next };
    },
  };
};

export const puller = createPuller();
