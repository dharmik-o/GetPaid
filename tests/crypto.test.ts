import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { decodeEncryptionKey } from "@/lib/encryption-key";

const KEY = randomBytes(32);
const box = createSecretBox(KEY);
const CONTEXT = "users.gmail_token_enc:aaaaaaaa-0000-4000-8000-000000000000";
const SECRET = "ya29.a0-fake-oauth-token";

const errorMessage = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return String(error);
  }
  throw new Error("expected the call to throw");
};

/** Swaps one base64url character in the given part (1 = iv, 2 = tag, 3 = ciphertext). */
const tamper = (value: string, part: 1 | 2 | 3): string => {
  const parts = value.split(":");
  const target = parts[part] ?? "";
  const first = target.startsWith("A") ? "B" : "A";
  parts[part] = first + target.slice(1);
  return parts.join(":");
};

describe("createSecretBox", () => {
  it.each([
    ["an OAuth token", SECRET],
    ["unicode", "clé secrète 🔑 नमस्ते"],
    ["an empty string", ""],
    ["a long value", "x".repeat(10_000)],
  ])("round-trips %s", (_label, plaintext) => {
    expect(box.decrypt(box.encrypt(plaintext, CONTEXT), CONTEXT)).toBe(plaintext);
  });

  it("produces versioned text that doesn't contain the plaintext", () => {
    const sealed = box.encrypt(SECRET, CONTEXT);
    expect(sealed).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]*$/);
    expect(sealed).not.toContain(SECRET);
  });

  it("uses a fresh IV every time, so equal secrets encrypt differently", () => {
    expect(box.encrypt(SECRET, CONTEXT)).not.toBe(box.encrypt(SECRET, CONTEXT));
  });

  it.each([
    { part: 1, name: "iv" },
    { part: 2, name: "auth tag" },
    { part: 3, name: "ciphertext" },
  ] as const)("rejects a tampered $name", ({ part }) => {
    const sealed = box.encrypt(SECRET, CONTEXT);
    expect(() => box.decrypt(tamper(sealed, part), CONTEXT)).toThrow(/Could not decrypt/);
  });

  it("rejects a value moved to another row or column (different context)", () => {
    const sealed = box.encrypt(SECRET, CONTEXT);
    expect(() =>
      box.decrypt(sealed, "users.gmail_token_enc:bbbbbbbb-0000-4000-8000-000000000000"),
    ).toThrow(/Could not decrypt/);
  });

  it("rejects a value encrypted with another key", () => {
    const sealed = createSecretBox(randomBytes(32)).encrypt(SECRET, CONTEXT);
    expect(() => box.decrypt(sealed, CONTEXT)).toThrow(/Could not decrypt/);
  });

  it.each(["plain text", "v2:a:b:c", "v1:only:three", ""])(
    "rejects %j as not produced by lib/crypto.ts",
    (value) => {
      expect(() => box.decrypt(value, CONTEXT)).toThrow(/not a value produced by lib\/crypto\.ts/);
    },
  );

  it("requires a context so ciphertexts are bound to where they are stored", () => {
    expect(() => box.encrypt(SECRET, "")).toThrow(/context/);
    expect(() => box.decrypt(box.encrypt(SECRET, CONTEXT), "")).toThrow(/context/);
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => createSecretBox(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("never puts the plaintext or the key in an error", () => {
    const sealed = box.encrypt(SECRET, CONTEXT);
    const message = errorMessage(() => box.decrypt(tamper(sealed, 3), CONTEXT));
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(KEY.toString("hex"));
    expect(message).not.toContain(KEY.toString("base64"));
  });
});

describe("decodeEncryptionKey", () => {
  const raw = randomBytes(32);

  it("accepts 64 hex characters", () => {
    expect(decodeEncryptionKey(raw.toString("hex")).equals(raw)).toBe(true);
  });

  it("accepts base64 of 32 bytes", () => {
    expect(decodeEncryptionKey(raw.toString("base64")).equals(raw)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(decodeEncryptionKey(`  ${raw.toString("hex")}\n`).equals(raw)).toBe(true);
  });

  it.each([
    ["too short", randomBytes(16).toString("hex")],
    ["a passphrase", "correct horse battery staple"],
    ["empty", ""],
  ])("rejects a key that is %s, without echoing it", (_label, value) => {
    const message = errorMessage(() => decodeEncryptionKey(value));
    expect(message).toMatch(/32 bytes/);
    if (value.length > 0) expect(message).not.toContain(value);
  });
});

describe("encryptSecret / decryptSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("encrypt with ENCRYPTION_KEY from the environment", async () => {
    vi.stubEnv("ENCRYPTION_KEY", KEY.toString("hex"));
    vi.stubEnv("DATABASE_URL", "postgres://postgres:pass@localhost:5432/app");
    vi.resetModules();
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");

    const sealed = encryptSecret(SECRET, CONTEXT);
    expect(box.decrypt(sealed, CONTEXT)).toBe(SECRET);
    expect(decryptSecret(box.encrypt(SECRET, CONTEXT), CONTEXT)).toBe(SECRET);
  });

  it("fail with the env error when ENCRYPTION_KEY is missing", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("DATABASE_URL", "postgres://postgres:pass@localhost:5432/app");
    vi.resetModules();
    const { encryptSecret } = await import("@/lib/crypto");

    expect(() => encryptSecret(SECRET, CONTEXT)).toThrow(/ENCRYPTION_KEY is missing/);
  });
});
