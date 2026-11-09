import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClientForm } from "@/components/ClientForm";
import { MaintenanceForm } from "@/components/MaintenanceForm";
import { ProjectForm, type ClientOption } from "@/components/ProjectForm";
import { RetainerForm } from "@/components/RetainerForm";
import { DEFAULT_SETTINGS } from "@/lib/settings";

// Lists first: a list page shows only the list, and the create form is one button away on its own
// page, where Cancel goes back.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = join(import.meta.dirname, "..", "apps", "web", "src", "app");
const source = (page: string): string => readFileSync(join(APP, page), "utf8");

const LIST_PAGES = [
  { page: "retainers/page.tsx", href: "/retainers/new", label: "Add retainer" },
  { page: "maintenance/page.tsx", href: "/maintenance/new", label: "Add maintenance job" },
  { page: "clients/page.tsx", href: "/clients/new", label: "Add client" },
  { page: "projects/page.tsx", href: "/projects/new", label: "New project" },
];

/** Every `<Link className="button" href="...">label</Link>` on a page, with its text tidied. */
const primaryLinks = (text: string): { href: string; label: string }[] =>
  [...text.matchAll(/<Link className="button" href="([^"]+)">\s*([^<]+?)\s*<\/Link>/g)].map(
    ([, href = "", label = ""]) => ({ href, label }),
  );

describe.each(LIST_PAGES)("the list page $page", ({ page, href, label }) => {
  it("doesn't contain a create form", () => {
    expect(source(page)).not.toMatch(/components\/\w*Form"/);
  });

  it(`offers "${label}" in the header and in the empty state`, () => {
    const links = primaryLinks(source(page)).filter((link) => link.href === href);
    expect(links).toEqual([
      { href, label },
      { href, label },
    ]);
  });
});

const CLIENT: ClientOption = {
  id: "c1",
  name: "Acme Ltd",
  timeZone: "America/New_York",
  inherited: DEFAULT_SETTINGS,
};

const cancelHref = (element: ReactElement): string | undefined => {
  const link = /<a [^>]*href="([^"]+)"[^>]*>Cancel<\/a>/.exec(renderToStaticMarkup(element));
  return link?.[1];
};

describe("the create forms' Cancel", () => {
  it("goes back to Retainers", () => {
    const form = createElement(RetainerForm, {
      clients: [{ id: "c1", name: "Acme Ltd", projects: [] }],
      today: "2026-11-05",
    });
    expect(cancelHref(form)).toBe("/retainers");
  });

  it("goes back to Maintenance", () => {
    const form = createElement(MaintenanceForm, {
      projects: [{ id: "p1", title: "Website", clientName: "Acme Ltd", currency: "USD" }],
      today: "2026-11-05",
    });
    expect(cancelHref(form)).toBe("/maintenance");
  });

  it("goes back to Clients, only when adding", () => {
    const props = { countries: [], allTimeZones: ["UTC"] };
    expect(cancelHref(createElement(ClientForm, props))).toBe("/clients");
    const initial = {
      id: "c1",
      name: "Acme",
      email: "a@example.test",
      country: "US",
      timeZone: "UTC",
      region: "",
      isBusiness: true,
    };
    expect(cancelHref(createElement(ClientForm, { ...props, initial }))).toBeUndefined();
  });

  it("goes where the new project page says, only when adding", () => {
    const adding = createElement(ProjectForm, { clients: [CLIENT], cancelHref: "/projects" });
    expect(cancelHref(adding)).toBe("/projects");
    const initial = {
      id: "p1",
      clientId: "c1",
      title: "Website",
      totalCents: 100,
      currency: "USD",
      deadline: "2026-12-01",
      contractTerms: null,
      lateFeeClause: null,
      settings: {},
    };
    expect(cancelHref(createElement(ProjectForm, { clients: [CLIENT], initial }))).toBeUndefined();
  });
});

describe("the form pages", () => {
  it.each([
    ["retainers/new/page.tsx", "<RetainerForm"],
    ["maintenance/new/page.tsx", "<MaintenanceForm"],
    ["clients/new/page.tsx", "<ClientForm"],
    ["projects/new/page.tsx", "<ProjectForm"],
  ])("%s holds the form", (page, form) => {
    expect(source(page)).toContain(form);
  });
});
