// What a signature image may be, shared by the form and the server. PNG or JPG only: never SVG, which
// can carry scripts. The first bytes must match the type it claims. Pure: safe in client components.

export const SIGNATURE_MAX_BYTES = 500 * 1024;
export const SIGNATURE_TYPES = ["image/png", "image/jpeg"];
/** The most a 500 KB file can be as a data URL. */
export const SIGNATURE_MAX_CHARS = 700_000;

export const SIGNATURE_DISCLAIMER =
  "This adds a picture of your signature. It isn't a legal e-signature.";

const DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_START = "iVBORw0KGgo";
const JPEG_START = "/9j/";

/** Bytes a base64 string decodes to, without decoding it. */
const decodedBytes = (base64: string): number =>
  Math.floor((base64.length * 3) / 4) - (base64.match(/=+$/)?.[0].length ?? 0);

/** What's wrong with an image, to follow its field's name; undefined when it's fine. */
export const signatureImageProblem = (dataUrl: string): string | undefined => {
  const match = DATA_URL.exec(dataUrl);
  const [, type, data = ""] = match ?? [];
  if (!match) return "must be a PNG or JPG image";
  if (!data.startsWith(type === "png" ? PNG_START : JPEG_START)) {
    return "must be a PNG or JPG image: this file's contents don't match its type";
  }
  return decodedBytes(data) > SIGNATURE_MAX_BYTES
    ? "is too large: use an image under 500 KB"
    : undefined;
};
