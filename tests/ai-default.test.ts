import { describe, expect, it } from "vitest";
import { readDefaultAi } from "../apps/web/src/lib/ai-default";

// The built-in AI model comes from the server's env and is used until a user saves their own.

const KEY = "test-key-not-real";

const problemOf = (env: Record<string, string>) => {
  const found = readDefaultAi(env);
  return found.ok ? null : found.problem;
};

describe("readDefaultAi", () => {
  it("nothing set: no built-in model, and nothing to complain about", () => {
    expect(readDefaultAi({})).toEqual({ ok: false, problem: null });
  });

  it("a preset, a model and a key: uses the preset's address", () => {
    const found = readDefaultAi({
      AI_DEFAULT_PROVIDER: "gemini",
      AI_DEFAULT_MODEL: "gemini-3.5-flash-lite",
      AI_DEFAULT_API_KEY: KEY,
    });
    expect(found).toMatchObject({
      ok: true,
      value: {
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        isLocal: false,
        apiKey: KEY,
      },
    });
  });

  it("a cloud preset without a key is refused, without echoing values", () => {
    const found = readDefaultAi({ AI_DEFAULT_PROVIDER: "gemini", AI_DEFAULT_MODEL: "x" });
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.problem).toMatch(/AI_DEFAULT_API_KEY is required/);
  });

  it("an unknown provider or a bad model id is refused", () => {
    expect(
      problemOf({
        AI_DEFAULT_PROVIDER: "nope",
        AI_DEFAULT_MODEL: "m",
        AI_DEFAULT_API_KEY: KEY,
      }),
    ).toMatch(/AI_DEFAULT_PROVIDER/);
    expect(
      problemOf({
        AI_DEFAULT_PROVIDER: "gemini",
        AI_DEFAULT_MODEL: "a b",
        AI_DEFAULT_API_KEY: KEY,
      }),
    ).toMatch(/AI_DEFAULT_MODEL/);
  });

  it("custom needs its own address", () => {
    expect(problemOf({ AI_DEFAULT_PROVIDER: "custom", AI_DEFAULT_MODEL: "m" })).toMatch(
      /AI_DEFAULT_BASE_URL/,
    );
  });
});
