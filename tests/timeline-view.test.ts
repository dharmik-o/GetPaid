import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineEntry } from "@/lib/timeline";

// The Timeline card, rendered on the server as the Client page does.

const AT = new Date("2026-12-04T15:00:00Z");

const entry = (overrides: Partial<TimelineEntry>): TimelineEntry => ({
  id: "e1",
  kind: "status",
  title: "Invoice sent",
  at: AT,
  reference: "FPR-000001",
  subject: null,
  body: null,
  aiLabel: null,
  stampId: null,
  ...overrides,
});

const render = (entries: TimelineEntry[]) =>
  renderToStaticMarkup(
    createElement(Timeline, {
      entries,
      clientZone: "America/New_York",
      ownZone: "Asia/Kolkata",
    }),
  ).replace(/<!-- -->/gu, "");

describe("Timeline", () => {
  it("explains the next step when it's empty", () => {
    expect(render([])).toContain("Nothing here yet");
  });

  it("names each kind in words, not only with an icon", () => {
    const html = render([
      entry({ id: "1", kind: "sent", title: "Firm reminder sent (Tier 2)" }),
      entry({ id: "2", kind: "reply", title: "The client replied" }),
      entry({ id: "3", kind: "payment", title: "USD 900.00 paid" }),
    ]);
    expect(html).toContain("Sent");
    expect(html).toContain("Reply");
    expect(html).toContain("Payment");
    expect(html).toContain("FPR-000001");
  });

  it("shows a send time in both zones, each named", () => {
    const html = render([entry({ kind: "sent" })]);
    expect(html).toContain("client time (America/New_York)");
    expect(html).toContain("yours (Asia/Kolkata)");
  });

  it("marks the AI's reading of a reply as a suggestion", () => {
    const html = render([
      entry({ kind: "reply", body: "Can I split it?", aiLabel: "installments" }),
    ]);
    expect(html).toContain("AI suggestion: Asks to pay in parts");
  });

  it("shows no AI line on a reply with no reading", () => {
    expect(render([entry({ kind: "reply", body: "Thanks" })])).not.toContain("AI suggestion");
  });

  it("escapes what a client wrote", () => {
    const html = render([entry({ kind: "reply", body: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("puts a sent email's words behind a toggle, so the page stays short", () => {
    const html = render([entry({ kind: "sent", subject: "Overdue", body: "Please pay." })]);
    expect(html).toContain("<details");
    expect(html).toContain("Overdue");
    expect(html).toContain("Please pay.");
  });
});
