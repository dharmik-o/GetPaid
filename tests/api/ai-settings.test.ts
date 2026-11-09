import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiSettingsHandlers } from "@/lib/ai-settings-handlers";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The AI settings API end to end: real migrations and RLS (PGlite). Keys are encrypted at
// rest, bound to the user and connection, and never come back to the browser.

let handle: TestDatabase;
const box = createSecretBox(randomBytes(32));
const CLAUDE_KEY = "sk-ant-test-key-never-shown-0001";

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const handlersFor = (userId = USER_A.userId) =>
  aiSettingsHandlers({ runAsUser: runnerFor(userId), box: () => box });

const put = (body: unknown, userId = USER_A.userId) =>
  handlersFor(userId).save(
    new Request("http://127.0.0.1:3000/api/settings/ai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (userId = USER_A.userId) => handlersFor(userId).get();

type Connection = {
  provider: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  hasKey: boolean;
};
type Settings = {
  main: Connection | null;
  cloudFallback: Connection | null;
  taskModels: { sort: string | null; tier3: string | null };
};
type Issue = { field: string; message: string };

const settingsOf = async (response: Response): Promise<Settings> =>
  ((await response.json()) as { settings: Settings }).settings;

const errorsOf = async (response: Response): Promise<Issue[]> => {
  expect(response.status).toBe(400);
  return ((await response.json()) as { errors: Issue[] }).errors;
};

const claude = {
  provider: "claude",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-sonnet-5-5",
};
const ollama = { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" };

const rows = async (userId = USER_A.userId) =>
  (
    await handle.db.query<{
      task: string;
      fallback_order: number;
      provider: string;
      model: string;
      is_local: boolean;
      api_key_enc: string | null;
    }>(
      `SELECT task, fallback_order, provider, model, is_local, api_key_enc
       FROM public.ai_providers WHERE user_id = $1 ORDER BY fallback_order, task`,
      [userId],
    )
  ).rows;

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.ai_providers WHERE user_id = $1", [USER_A.userId]);
});

afterAll(async () => {
  await handle.close();
});

describe("GET /api/settings/ai", () => {
  it("is empty until the user picks a model", async () => {
    expect(await settingsOf(await get())).toEqual({
      main: null,
      cloudFallback: null,
      taskModels: { sort: null, tier3: null },
    });
  });

  it("shows only the user's own settings (RLS)", async () => {
    await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: null });
    // User B's fixture row is theirs alone; user A's save never touched it.
    const b = await settingsOf(await get(USER_B.userId));
    expect(b.main?.model).toBe("mock");
    expect(b.main?.provider).toBe("custom");
  });
});

describe("PUT /api/settings/ai", () => {
  it("saves a cloud model, encrypting the key bound to the user, for every task", async () => {
    const response = await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: null });
    const text = await response.clone().text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(CLAUDE_KEY);
    expect((await settingsOf(response)).main).toEqual({
      ...claude,
      isLocal: false,
      hasKey: true,
    });

    const saved = await rows();
    expect(saved.map((r) => [r.task, r.fallback_order, r.model])).toEqual([
      ["draft", 1, "claude-sonnet-5-5"],
      ["sort", 1, "claude-sonnet-5-5"],
      ["tier3", 1, "claude-sonnet-5-5"],
    ]);
    for (const row of saved) {
      expect(row.api_key_enc).toMatch(/^v1:/);
      expect(row.api_key_enc).not.toContain(CLAUDE_KEY);
      expect(
        box.decrypt(row.api_key_enc ?? "", `ai_providers.api_key_enc:${USER_A.userId}:1`),
      ).toBe(CLAUDE_KEY);
    }
    expect(await get().then((r) => r.text())).not.toContain(CLAUDE_KEY);
  });

  it("keeps the stored key when it's left blank and the address is the same", async () => {
    await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: null });
    const again = await put({
      main: { ...claude, model: "claude-haiku-5-5" },
      cloudFallback: null,
    });
    expect((await settingsOf(again)).main).toMatchObject({
      model: "claude-haiku-5-5",
      hasKey: true,
    });
  });

  it("never sends a stored key to a different address: it must be entered again", async () => {
    await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: null });
    const errors = await errorsOf(
      await put({
        main: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-x" },
        cloudFallback: null,
      }),
    );
    expect(errors).toEqual([
      { field: "main.apiKey", message: expect.stringMatching(/is required/) as string },
    ]);
  });

  it("removes a key when it's cleared", async () => {
    const custom = { provider: "custom", baseUrl: "https://llm.example.test/v1", model: "m1" };
    await put({ main: { ...custom, apiKey: "k-1" }, cloudFallback: null });
    const cleared = await put({ main: { ...custom, apiKey: "" }, cloudFallback: null });
    expect((await settingsOf(cleared)).main?.hasKey).toBe(false);
    expect((await rows()).every((r) => r.api_key_enc === null)).toBe(true);
  });

  it("needs a key for presets that use one", async () => {
    const errors = await errorsOf(await put({ main: claude, cloudFallback: null }));
    expect(errors[0]?.field).toBe("main.apiKey");
  });

  it("saves a local model with a cloud fallback and per-task models", async () => {
    const response = await put({
      main: ollama,
      cloudFallback: { ...claude, apiKey: CLAUDE_KEY },
      taskModels: { sort: "llama3.2:1b", tier3: null },
    });
    expect(response.status).toBe(200);
    const settings = await settingsOf(response);
    expect(settings.main).toEqual({ ...ollama, isLocal: true, hasKey: false });
    expect(settings.cloudFallback).toMatchObject({ provider: "claude", hasKey: true });
    expect(settings.taskModels).toEqual({ sort: "llama3.2:1b", tier3: null });
    const saved = await rows();
    expect(saved.map((r) => [r.task, r.fallback_order, r.model, r.is_local])).toEqual([
      ["draft", 1, "llama3.2", true],
      ["sort", 1, "llama3.2:1b", true],
      ["tier3", 1, "llama3.2", true],
      ["draft", 2, "claude-sonnet-5-5", false],
      ["sort", 2, "claude-sonnet-5-5", false],
      ["tier3", 2, "claude-sonnet-5-5", false],
    ]);
    const fallbackKey = saved.find((r) => r.fallback_order === 2)?.api_key_enc ?? "";
    expect(box.decrypt(fallbackKey, `ai_providers.api_key_enc:${USER_A.userId}:2`)).toBe(
      CLAUDE_KEY,
    );
  });

  it("allows a cloud fallback only behind a local model, and only a cloud one", async () => {
    const behindCloud = await errorsOf(
      await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: ollama }),
    );
    expect(behindCloud[0]?.field).toBe("cloudFallback");
    const localFallback = await errorsOf(await put({ main: ollama, cloudFallback: ollama }));
    expect(localFallback[0]?.field).toBe("cloudFallback");
  });

  it("refuses plain http for a cloud model, so keys never travel unencrypted", async () => {
    const errors = await errorsOf(
      await put({
        main: {
          provider: "custom",
          baseUrl: "http://llm.example.test/v1",
          model: "m1",
          isLocal: false,
        },
        cloudFallback: null,
      }),
    );
    expect(errors[0]?.field).toBe("main.baseUrl");
    expect(errors[0]?.message).toMatch(/https/);
  });

  it.each([
    ["not a URL", "llm.example.test"],
    ["a non-web scheme", "file:///etc/passwd"],
    ["credentials in the URL", "https://user:pass@llm.example.test/v1"],
    ["a cloud metadata address", "http://169.254.169.254/v1"],
  ])("refuses a base URL with %s", async (_label, baseUrl) => {
    const errors = await errorsOf(
      await put({
        main: { provider: "custom", baseUrl, model: "m1", isLocal: true },
        cloudFallback: null,
      }),
    );
    expect(errors[0]?.field).toBe("main.baseUrl");
  });

  it("refuses odd model names, unknown providers and unknown fields", async () => {
    const errors = await errorsOf(
      await put({
        main: { ...ollama, model: "llama 3; drop" },
        cloudFallback: null,
        extra: true,
      }),
    );
    expect(errors.map((e) => e.field).sort()).toEqual(["extra", "main.model"]);
    const unknown = await errorsOf(
      await put({ main: { ...ollama, provider: "skynet" }, cloudFallback: null }),
    );
    expect(unknown[0]?.field).toBe("main.provider");
  });

  it("doesn't touch another user's settings", async () => {
    await put({ main: ollama, cloudFallback: null });
    expect((await rows(USER_B.userId)).map((r) => r.model)).toEqual(["mock"]);
  });
});

describe("PUT /api/settings/ai on the public demo", () => {
  const demo = () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "true");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["http://postgres:5432/v1", "http://n8n:5678/v1", "https://evil.example.com/v1"])(
    "refuses a custom URL of %s",
    async (baseUrl) => {
      demo();
      const errors = await errorsOf(
        await put({
          main: { provider: "custom", baseUrl, model: "m1", isLocal: true },
          cloudFallback: null,
        }),
      );
      expect(errors[0]?.field).toBe("main.baseUrl");
      expect(await rows()).toEqual([]);
    },
  );

  it("still saves a known provider", async () => {
    demo();
    expect(
      (await put({ main: { ...claude, apiKey: CLAUDE_KEY }, cloudFallback: null })).status,
    ).toBe(200);
  });
});
