const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

export const ENCRYPTION_KEY_HELP =
  "must be 32 bytes, written as 64 hex characters or as base64. Generate one with: openssl rand -hex 32";

/** Decodes ENCRYPTION_KEY (hex or base64) to 32 raw bytes. The error never echoes the value. */
export const decodeEncryptionKey = (text: string): Buffer => {
  const value = text.trim();
  if (HEX_KEY.test(value)) return Buffer.from(value, "hex");
  if (BASE64_KEY.test(value)) {
    const key = Buffer.from(value, "base64");
    if (key.length === KEY_BYTES) return key;
  }
  throw new Error(`ENCRYPTION_KEY ${ENCRYPTION_KEY_HELP}`);
};
