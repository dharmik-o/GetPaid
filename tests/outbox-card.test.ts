import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OutboxCard } from "@/components/OutboxCard";
import type { OutboxItem } from "@/lib/outbox";
import type { StoredDraft } from "@/lib/stored-draft";

// The card, rendered on the server as the Outbox page does: each tab offers only what's allowed.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-1";

const draft: StoredDraft = {
  subject: "Invoice FPR-1 is overdue",
  body: `Please pay here: ${PAY_LINK}`,
  kind: "tier1",
  via: "model",
  model: "claude-sonnet-5-5",
  isLocal: false,
  citation: null,
  lawId: null,
  notLegalAdvice: false,
  draftedAt: "2026-12-22T14:00:00.000Z",
};

const base: OutboxItem = {
  id: "r1",
  tab: "waiting",
  clientName: "Acme Ltd",
  what: "Website · Build · FPR-1",
  amountDue: "USD 1,500.00",
  tier: "tier1",
  sendTime:
    "Wed 23 Dec, 10:00 client time (America/New_York), Wed 23 Dec, 20:30 yours (Asia/Kolkata)",
  sendAtInput: "2026-12-23T10:00",
  clientTimeZone: "America/New_York",
  window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  nudgeHours: 24,
  payLink: PAY_LINK,
  draft,
  approvedVia: null,
};

const render = (overrides: Partial<OutboxItem> = {}) =>
  renderToStaticMarkup(createElement(OutboxCard, { item: { ...base, ...overrides } })).replace(
    /<!-- -->/gu,
    "",
  );

describe("OutboxCard", () => {
  it("shows the client, amount, tier, both times and the full message with its link", () => {
    const html = render();
    for (const text of [
      "Acme Ltd",
      "Website · Build · FPR-1",
      "USD 1,500.00",
      "Tier 1",
      "10:00 client time (America/New_York)",
      "20:30 yours (Asia/Kolkata)",
      "Invoice FPR-1 is overdue",
      PAY_LINK,
    ]) {
      expect(html).toContain(text);
    }
  });

  it("offers every action on a waiting draft", () => {
    const html = render();
    for (const text of ["Approve and send", "Edit", "Reschedule", "Skip"]) {
      expect(html).toContain(text);
    }
  });

  it("offers only rescheduling or stopping once approved", () => {
    const html = render({ tab: "scheduled", approvedVia: "telegram" });
    expect(html).not.toContain("Approve and send");
    expect(html).not.toContain(">Edit<");
    expect(html).toContain("Reschedule");
    expect(html).toContain("Stop this send");
    expect(html).toContain("Approved in Telegram");
  });

  it.each(["sent", "skipped"] as const)("offers no action on a %s draft", (tab) => {
    const html = render({ tab, sendTime: tab === "sent" ? base.sendTime : null });
    expect(html).not.toContain("<button");
  });

  it("offers only Skip for a draft that failed its checks", () => {
    const html = render({ draft: null });
    expect(html).toContain("failed its checks");
    expect(html).not.toContain("Approve and send");
    expect(html).not.toContain("Reschedule");
    expect(html).toContain("Skip");
  });

  it("escapes a message rather than rendering it as HTML", () => {
    const html = render({ draft: { ...draft, body: `<img src=x onerror=alert(1)> ${PAY_LINK}` } });
    expect(html).not.toContain("<img");
  });

  it("says a final notice isn't legal advice", () => {
    expect(render({ tier: "tier3", draft: { ...draft, notLegalAdvice: true } })).toContain(
      "not legal advice",
    );
  });

  it("marks a draft you edited", () => {
    expect(render({ draft: { ...draft, editedAt: "2026-12-22T15:00:00.000Z" } })).toContain(
      "Edited by you",
    );
  });
});
