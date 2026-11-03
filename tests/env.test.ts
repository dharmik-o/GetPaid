import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerEnv, SERVER_ENV_NAMES } from "@/lib/env";

const KEY_HEX = randomBytes(32).toString("hex");
const DB_PASSWORD = "db-pass-not-for-logs";
const VALID = {
  ENCRYPTION_KEY: KEY_HEX,
  DATABASE_URL: `postgres://postgres:${DB_PASSWORD}@localhost:5432/app`,
};

const messageFor = (source: Record<string, string | undefined>): string => {
  try {
    parseServerEnv(source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected parseServerEnv to throw");
};

describe("parseServerEnv", () => {
  it("returns the checked env, with the encryption key decoded to 32 bytes", () => {
    const env = parseServerEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.ENCRYPTION_KEY.equals(Buffer.from(KEY_HEX, "hex"))).toBe(true);
  });

  it("ignores variables it doesn't know", () => {
    expect(() => parseServerEnv({ ...VALID, PATH: "/usr/bin" })).not.toThrow();
  });

  it.each(["ENCRYPTION_KEY", "DATABASE_URL"] as const)(
    "fails with a clear message when %s is missing",
    (name) => {
      const message = messageFor({ ...VALID, [name]: undefined });
      expect(message).toContain(name);
      expect(message).toMatch(/missing/);
      expect(message).toContain(".env.example");
    },
  );

  it("treats an empty value as missing", () => {
    expect(messageFor({ ...VALID, ENCRYPTION_KEY: "" })).toMatch(/ENCRYPTION_KEY.*missing/);
  });

  it("lists every problem at once", () => {
    const message = messageFor({});
    expect(message).toContain("ENCRYPTION_KEY");
    expect(message).toContain("DATABASE_URL");
  });

  it("explains how to make a valid ENCRYPTION_KEY, without echoing the bad value", () => {
    const bad = "short-key-value";
    const message = messageFor({ ...VALID, ENCRYPTION_KEY: bad });
    expect(message).toMatch(/ENCRYPTION_KEY.*32 bytes/);
    expect(message).toContain("openssl rand -hex 32");
    expect(message).not.toContain(bad);
  });

  it("rejects a DATABASE_URL that isn't a postgres:// URL, without echoing it", () => {
    const message = messageFor({ ...VALID, DATABASE_URL: `mysql://root:${DB_PASSWORD}@db/app` });
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(DB_PASSWORD);
  });
});

describe("SERVER_ENV_NAMES", () => {
  it("are all documented in .env.example", () => {
    const example = readFileSync(join(import.meta.dirname, "..", ".env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^(\w+)=/gm)].map((match) => match[1]));
    for (const name of SERVER_ENV_NAMES) {
      expect(documented.has(name), `${name} missing from .env.example`).toBe(true);
    }
  });
});
