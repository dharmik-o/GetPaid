import { describe, expect, it } from "vitest";
import { buildReminderEmail, toGmailRaw, type ReminderEmail } from "@/lib/reminder-email";

// The reminder email: plain text with the invoice PDF always attached.

const PDF = Buffer.from("%PDF-1.7\nfake invoice bytes for the test\n%%EOF");

const email = (overrides: Partial<ReminderEmail> = {}): ReminderEmail => ({
  from: { name: "Alex Rivera", email: "alex@example.test" },
  to: { name: "Sam Lee", email: "sam@example.test" },
  subject: "Friendly reminder: invoice FPR-000042",
  body: "Hi Sam,\n\nA quick reminder.\n\nhttps://www.sandbox.paypal.com/invoice/p/#INV2-TEST",
  pdf: { pdf: PDF, filename: "invoice-FPR-000042.pdf" },
  ...overrides,
});

/** The parts between the boundaries, as { headers, body } with base64 decoded. */
const parts = (mime: string) => {
  const boundary = /boundary="([^"]+)"/.exec(mime)?.[1] ?? "";
  return mime
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [headers = "", content = ""] = part.trim().split("\r\n\r\n");
      return { headers, body: Buffer.from(content.replace(/\r\n/g, ""), "base64") };
    });
};

describe("buildReminderEmail", () => {
  it("attaches the invoice PDF, byte for byte", () => {
    const [text, attachment] = parts(buildReminderEmail(email()));
    expect(text?.headers).toContain("text/plain");
    expect(text?.body.toString("utf8")).toContain("A quick reminder.");
    expect(attachment?.headers).toContain("Content-Type: application/pdf");
    expect(attachment?.headers).toContain('attachment; filename="invoice-FPR-000042.pdf"');
    expect(attachment?.body.equals(PDF)).toBe(true);
  });

  it("stays on the original thread", () => {
    const mime = buildReminderEmail(email({ inReplyTo: "<abc123@mail.example.test>" }));
    expect(mime).toContain("In-Reply-To: <abc123@mail.example.test>");
    expect(mime).toContain("References: <abc123@mail.example.test>");
  });

  it("can't gain headers through the subject or a name", () => {
    const mime = buildReminderEmail(
      email({
        subject: "Hi\r\nBcc: everyone@example.test",
        to: { name: 'Sam"\r\nBcc: x@example.test', email: "sam@example.test" },
      }),
    );
    const headers = mime.split("\r\n\r\n")[0] ?? "";
    expect(headers.split("\r\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
  });

  it("encodes non-ASCII subjects and names", () => {
    const mime = buildReminderEmail(
      email({ subject: "Rappel : facture échue", from: { name: "Zoë", email: "z@example.test" } }),
    );
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(mime).toMatch(/From: "=\?UTF-8\?B\?[^"]+\?=" <z@example\.test>/);
  });

  it("gives Gmail a base64url message", () => {
    expect(toGmailRaw("a+b/c")).toBe(Buffer.from("a+b/c").toString("base64url"));
  });
});
