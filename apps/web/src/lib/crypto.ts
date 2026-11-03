// Server only: encrypts API keys and OAuth tokens at rest. Never import into client components.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadServerEnv } from "./env";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[\w-]*$/;

const NOT_OURS =
  "The stored secret is not a value produced by lib/crypto.ts (expected v1:iv:tag:ciphertext). Ask the user to enter the secret again.";
const CANNOT_DECRYPT =
  "Could not decrypt the stored secret: ENCRYPTION_KEY changed, the value was altered, or it belongs to another record. Ask the user to enter the secret again.";

export interface SecretBox {
  /** Encrypts `plaintext`, bound to `context` (e.g. "users.gmail_token_enc:<user id>"). */
  encrypt: (plaintext: string, context: string) => string;
  /** Decrypts a value from `encrypt`; the context must match the one used to encrypt it. */
  decrypt: (sealed: string, context: string) => string;
}

const contextBytes = (context: string): Buffer => {
  if (context.length === 0) {
    throw new Error(
      'Encryption needs a context such as "users.gmail_token_enc:<user id>", so a stored value can\'t be moved to another record. Pass one and try again.',
    );
  }
  return Buffer.from(context, "utf8");
};

const parseSealed = (sealed: string): { iv: Buffer; tag: Buffer; data: Buffer } => {
  const parts = sealed.split(":");
  const [version, iv = "", tag = "", data = ""] = parts;
  const wellFormed =
    parts.length === 4 &&
    version === VERSION &&
    iv !== "" &&
    tag !== "" &&
    [iv, tag, data].every((part) => BASE64URL.test(part));
  if (!wellFormed) throw new Error(NOT_OURS);
  return {
    iv: Buffer.from(iv, "base64url"),
    tag: Buffer.from(tag, "base64url"),
    data: Buffer.from(data, "base64url"),
  };
};

/** AES-256-GCM with a fresh random IV per value; the context is authenticated as AAD. */
export const createSecretBox = (key: Buffer): SecretBox => {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      "The encryption key must be exactly 32 bytes. Check ENCRYPTION_KEY (see .env.example).",
    );
  }
  return {
    encrypt: (plaintext, context) => {
      const aad = contextBytes(context);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const encoded = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url"));
      return [VERSION, ...encoded].join(":");
    },
    decrypt: (sealed, context) => {
      const aad = contextBytes(context);
      const { iv, tag, data } = parseSealed(sealed);
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error(CANNOT_DECRYPT);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch (error) {
        throw new Error(CANNOT_DECRYPT, { cause: error });
      }
    },
  };
};

let defaultBox: SecretBox | undefined;
const secretBox = (): SecretBox => (defaultBox ??= createSecretBox(loadServerEnv().ENCRYPTION_KEY));

/** Encrypts with ENCRYPTION_KEY. Store the result in an *_enc column. */
export const encryptSecret = (plaintext: string, context: string): string =>
  secretBox().encrypt(plaintext, context);

/** Decrypts an *_enc value with ENCRYPTION_KEY. Never send the result to the browser. */
export const decryptSecret = (sealed: string, context: string): string =>
  secretBox().decrypt(sealed, context);
