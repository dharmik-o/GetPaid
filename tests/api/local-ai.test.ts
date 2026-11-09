import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPuller, localAiStatus, type PullJob } from "@/lib/local-ai";
import { localAiHandlers } from "@/lib/local-ai-handlers";

// Local AI (Ollama) on demand: the status check, and the model download route. Ollama is an msw
// mock; no real network calls.

const BASE = "http://ollama.test:11434";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const lines = (...items: object[]) => items.map((item) => `${JSON.stringify(item)}\n`).join("");

describe("localAiStatus", () => {
  it("says off when Ollama is down", async () => {
    server.use(http.get(`${BASE}/api/tags`, () => HttpResponse.error()));
    expect(await localAiStatus(BASE)).toEqual({ up: false });
  });

  it("says off when Ollama answers with an error or nonsense", async () => {
    server.use(http.get(`${BASE}/api/tags`, () => new HttpResponse("nope", { status: 502 })));
    expect(await localAiStatus(BASE)).toEqual({ up: false });
    server.use(http.get(`${BASE}/api/tags`, () => HttpResponse.json({ unexpected: true })));
    expect(await localAiStatus(BASE)).toEqual({ up: false });
  });

  it("lists the downloaded models when Ollama is up", async () => {
    server.use(
      http.get(`${BASE}/api/tags`, () =>
        HttpResponse.json({ models: [{ name: "llama3.2:latest" }, { name: "qwen2.5:3b" }] }),
      ),
    );
    expect(await localAiStatus(BASE)).toEqual({
      up: true,
      models: ["llama3.2:latest", "qwen2.5:3b"],
    });
  });
});

describe("the model download route", () => {
  const pull = (handlers: ReturnType<typeof localAiHandlers>, body: unknown) =>
    handlers.pull(
      new Request("http://127.0.0.1:3000/api/settings/ai/local-models/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const build = (over: { signedIn?: boolean; demo?: boolean } = {}) => {
    const puller = createPuller(() => BASE);
    const handlers = localAiHandlers({
      puller,
      userId: () => {
        if (over.signedIn === false) throw new Error("nobody");
        return "00000000-0000-4000-8000-000000000001";
      },
      demoMode: () => over.demo ?? false,
    });
    return { handlers, puller };
  };

  const neverCalled = () => {
    const called = vi.fn();
    server.use(
      http.post(`${BASE}/api/pull`, () => {
        called();
        return new HttpResponse(lines({ status: "success" }));
      }),
    );
    return called;
  };

  it.each(["", "Llama3.2", "../etc/passwd", "a b", "x".repeat(82), "-lead", "model;rm -rf"])(
    "refuses the invalid model name %j without calling Ollama",
    async (model) => {
      const called = neverCalled();
      const response = await pull(build().handlers, { model });
      expect(response.status).toBe(400);
      expect(called).not.toHaveBeenCalled();
    },
  );

  it("refuses without a signed-in user, for starting and for progress", async () => {
    const called = neverCalled();
    const { handlers } = build({ signedIn: false });
    expect((await pull(handlers, { model: "llama3.2" })).status).toBe(401);
    expect(handlers.get().status).toBe(401);
    expect(called).not.toHaveBeenCalled();
  });

  it("answers 403 in demo mode and never calls Ollama", async () => {
    const called = neverCalled();
    const response = await pull(build({ demo: true }).handlers, { model: "llama3.2" });
    expect(response.status).toBe(403);
    expect(called).not.toHaveBeenCalled();
  });

  it("downloads a model and reports progress until done", async () => {
    let sent: unknown;
    server.use(
      http.post(`${BASE}/api/pull`, async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(
          lines(
            { status: "pulling manifest" },
            { status: "pulling abc", total: 200, completed: 50 },
            { status: "success" },
          ),
        );
      }),
    );
    const { handlers } = build();
    const response = await pull(handlers, { model: "qwen2.5:3b" });
    expect(response.status).toBe(202);
    expect(sent).toEqual({ model: "qwen2.5:3b", stream: true });
    await vi.waitFor(async () => {
      const { job } = (await handlers.get().json()) as { job: PullJob | null };
      expect(job).toMatchObject({ model: "qwen2.5:3b", state: "done" });
    });
  });

  it("allows one download at a time", async () => {
    let finish: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.post(`${BASE}/api/pull`, () => {
        const encoder = new TextEncoder();
        return new HttpResponse(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(lines({ status: "pulling manifest" })));
              await open;
              controller.enqueue(encoder.encode(lines({ status: "success" })));
              controller.close();
            },
          }),
        );
      }),
    );
    const { handlers } = build();
    expect((await pull(handlers, { model: "llama3.2" })).status).toBe(202);
    expect((await pull(handlers, { model: "qwen2.5:3b" })).status).toBe(409);
    finish();
    await vi.waitFor(async () => {
      const { job } = (await handlers.get().json()) as { job: PullJob | null };
      expect(job?.state).toBe("done");
    });
    expect((await pull(handlers, { model: "qwen2.5:3b" })).status).toBe(202);
  });

  it("says local AI is off (503) when Ollama can't be reached", async () => {
    server.use(http.post(`${BASE}/api/pull`, () => HttpResponse.error()));
    expect((await pull(build().handlers, { model: "llama3.2" })).status).toBe(503);
  });

  it("says Ollama refused the request (502), not that it is off, on an HTTP error", async () => {
    server.use(http.post(`${BASE}/api/pull`, () => new HttpResponse("bad", { status: 400 })));
    const response = await pull(build().handlers, { model: "llama3.2" });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("is off");
  });

  it("marks the download failed when Ollama reports an error", async () => {
    server.use(
      http.post(
        `${BASE}/api/pull`,
        () => new HttpResponse(lines({ error: "pull model manifest: not found" })),
      ),
    );
    const { handlers } = build();
    await pull(handlers, { model: "nosuchmodel" });
    await vi.waitFor(async () => {
      const { job } = (await handlers.get().json()) as { job: PullJob | null };
      expect(job?.state).toBe("failed");
    });
  });
});
