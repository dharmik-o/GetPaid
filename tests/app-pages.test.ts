import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every route file must be a real page: Next.js errors on a page.tsx with no default export
// (the scaffold's one-line placeholders did exactly that for Outbox, Retainers, Maintenance
// and Settings), and every sidebar link must lead to one.

const APP = join(import.meta.dirname, "..", "apps", "web", "src", "app");

const pageFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageFiles(path);
    return name === "page.tsx" ? [path] : [];
  });

const PAGES = pageFiles(APP).map((path) => relative(APP, path).replaceAll("\\", "/"));

describe("app pages", () => {
  it.each(PAGES)("%s has a default export", (page) => {
    expect(readFileSync(join(APP, page), "utf8")).toMatch(/^export default /m);
  });

  it("has a page for every sidebar link", () => {
    const sidebar = readFileSync(join(APP, "..", "components", "Sidebar.tsx"), "utf8");
    const hrefs = [...sidebar.matchAll(/href: "([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const page = href === "/" ? "page.tsx" : `${href.slice(1)}/page.tsx`;
      expect(PAGES, `no page for ${href}`).toContain(page);
    }
  });

  it("links Settings to the AI settings screen", () => {
    expect(readFileSync(join(APP, "settings", "page.tsx"), "utf8")).toContain(
      'href="/settings/ai"',
    );
  });
});
