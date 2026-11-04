import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceForm } from "@/components/MaintenanceForm";
import { ProjectForm } from "@/components/ProjectForm";
import { RetainerForm } from "@/components/RetainerForm";
import { DEFAULT_SETTINGS } from "@/lib/settings";

// Every currency dropdown explains why INR isn't there, and screen readers hear it with the field.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const NOTE =
  "INR isn't listed because PayPal can't receive rupee payments. Bill in your client's currency, and PayPal converts to INR when you withdraw.";

const FORMS: [string, string, ReactElement][] = [
  [
    "the project form",
    "currency",
    createElement(ProjectForm, {
      clients: [
        { id: "c1", name: "Acme", timeZone: "America/New_York", inherited: DEFAULT_SETTINGS },
      ],
    }),
  ],
  [
    "the retainer form",
    "retainer-currency",
    createElement(RetainerForm, {
      clients: [{ id: "c1", name: "Acme", projects: [] }],
      today: "2026-11-05",
    }),
  ],
  [
    "the maintenance form",
    "maintenance-currency",
    createElement(MaintenanceForm, {
      projects: [{ id: "p1", title: "Website", clientName: "Acme", currency: "USD" }],
      today: "2026-11-05",
    }),
  ],
];

describe.each(FORMS)("%s", (_name, selectId, form) => {
  const html = renderToStaticMarkup(form).replaceAll("&#x27;", "'");

  it("shows the note, word for word, after the dropdown", () => {
    expect(html).toContain(NOTE);
    expect(html.indexOf(`id="${selectId}"`)).toBeLessThan(html.indexOf(NOTE));
  });

  it("ties the note to the dropdown for screen readers", () => {
    const select = new RegExp(`<select[^>]*id="${selectId}"[^>]*>`).exec(html)?.[0] ?? "";
    const describedBy = /aria-describedby="([^"]+)"/.exec(select)?.[1] ?? "";
    const noteId = new RegExp(`id="([^"]+)"[^>]*>${NOTE}`).exec(html)?.[1];
    expect(noteId).toBeDefined();
    expect(describedBy.split(" ")).toContain(noteId);
  });

  it("doesn't offer INR", () => {
    expect(html).not.toContain('value="INR"');
  });
});
