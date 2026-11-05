import { describe, expect, it } from "vitest";
import { renderTypedSignature } from "@/lib/invoice-pdf";
import {
  SIGNATURE_DISCLAIMER,
  SIGNATURE_MAX_BYTES,
  signatureImageProblem,
} from "@/lib/signature-rules";

// What a signature image may be, and drawing a typed name with real headless Chromium, offline.

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQ=";

describe("a signature image", () => {
  it.each([
    ["a PNG", `data:image/png;base64,${PNG}`],
    ["a JPG", `data:image/jpeg;base64,${JPEG}`],
  ])("may be %s", (_what, image) => {
    expect(signatureImageProblem(image)).toBeUndefined();
  });

  it.each([
    ["an SVG, which can carry scripts", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["a GIF", "data:image/gif;base64,R0lGODlhAQABAAAAACw="],
    ["a WebP", "data:image/webp;base64,UklGRg=="],
    ["a link", "https://example.test/signature.png"],
    ["something that isn't an image", "hello"],
    ["script in a data URL", "data:text/html;base64,PHNjcmlwdD4="],
  ])("may not be %s", (_what, image) => {
    expect(signatureImageProblem(image)).toBe("must be a PNG or JPG image");
  });

  it("is checked by its contents, not just the type it claims", () => {
    expect(signatureImageProblem(`data:image/png;base64,${JPEG}`)).toContain("don't match");
    expect(signatureImageProblem("data:image/png;base64,PHN2Zz48L3N2Zz4=")).toContain(
      "don't match",
    );
  });

  it("may be up to 500 KB, and no more", () => {
    const sized = (bytes: number) => {
      const padding = "A".repeat(Math.ceil((bytes * 4) / 3) - PNG.length - 2);
      return `data:image/png;base64,${PNG.slice(0, -2)}${padding}==`;
    };
    expect(signatureImageProblem(sized(SIGNATURE_MAX_BYTES - 16))).toBeUndefined();
    expect(signatureImageProblem(sized(SIGNATURE_MAX_BYTES + 16))).toContain("under 500 KB");
  });
});

describe("the note beside the setting", () => {
  it("says what it is, and what it isn't", () => {
    expect(SIGNATURE_DISCLAIMER).toBe(
      "This adds a picture of your signature. It isn't a legal e-signature.",
    );
  });
});

describe("drawing a typed name", () => {
  it("makes a PNG that passes the same checks as an upload", async () => {
    const image = await renderTypedSignature("Alex Rivera");
    expect(image).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(signatureImageProblem(image)).toBeUndefined();
    expect(image.length).toBeGreaterThan(1000);
  }, 60_000);

  it("draws each name differently", async () => {
    expect(await renderTypedSignature("Sam Lee")).not.toBe(await renderTypedSignature("Ana Díaz"));
  }, 60_000);

  it("treats a name as text, never as markup", async () => {
    const image = await renderTypedSignature('<img src=x onerror="fetch(1)">');
    expect(signatureImageProblem(image)).toBeUndefined();
  }, 60_000);
});
