import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaidBadge, PaidMoment } from "@/components/PaidMoment";
import { claimPaidStamp, holdStampId, invoiceStampId, PAID_STAMPS_KEY } from "@/lib/paid-stamps";

// Which paid items have already had their stamp. tests/e2e/z-paid-stamp.spec.ts runs the whole moment
// in a real browser.

type Store = Pick<Storage, "getItem" | "setItem">;

const memoryStore = (start: Record<string, string> = {}): Store => {
  const data = new Map(Object.entries(start));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
};

describe("claiming a stamp", () => {
  it("says yes the first time and no after that", () => {
    const store = memoryStore();
    expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(true);
    expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(false);
  });

  it("keeps each paid item separate", () => {
    const store = memoryStore();
    expect(claimPaidStamp("invoice:FPR-000001", store)).toBe(true);
    expect(claimPaidStamp("invoice:FPR-000002", store)).toBe(true);
    expect(claimPaidStamp("invoice:FPR-000001", store)).toBe(false);
  });

  it("remembers across page loads, through storage", () => {
    const store = memoryStore();
    claimPaidStamp("invoice:FPR-000042", store);
    expect(JSON.parse(store.getItem(PAID_STAMPS_KEY) ?? "")).toEqual(["invoice:FPR-000042"]);
  });

  it("starts again if what's stored isn't a list of IDs", () => {
    for (const bad of ["not json", '{"a":1}', "[1,2]"]) {
      const store = memoryStore({ [PAID_STAMPS_KEY]: bad });
      expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(true);
      expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(false);
    }
  });

  it("doesn't play if storage can't be read, as it would replay on every load", () => {
    const store: Store = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(false);
  });

  it("doesn't play if storage can't be written, for the same reason", () => {
    const store: Store = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(claimPaidStamp("invoice:FPR-000042", store)).toBe(false);
  });

  it("doesn't play where there's no browser storage at all", () => {
    expect(claimPaidStamp("invoice:FPR-000042")).toBe(false);
  });
});

describe("stamp IDs", () => {
  it("keep invoices and holds apart", () => {
    expect(invoiceStampId("FPR-000042")).toBe("invoice:FPR-000042");
    expect(holdStampId("h1")).toBe("hold:h1");
  });
});

describe("the paid moment on the server", () => {
  const render = (paid: boolean) =>
    renderToStaticMarkup(
      createElement(PaidMoment, {
        stampId: "invoice:FPR-000042",
        announcement: "FPR-000042 paid",
        paid,
        children: createElement(PaidBadge),
      }),
    );

  it("renders the row without a stamp: it only plays in the browser", () => {
    expect(render(true)).not.toContain("paid-stamp");
    expect(render(true)).toContain('class="badge badge-paid"');
  });

  it("has an empty live region ready for a paid item, so the announcement is heard", () => {
    expect(render(true)).toMatch(/aria-live="polite"[^>]*><\/span>/);
    expect(render(true)).not.toContain("FPR-000042 paid");
  });

  it("has no live region on an item that isn't paid", () => {
    expect(render(false)).not.toContain("aria-live");
  });
});
