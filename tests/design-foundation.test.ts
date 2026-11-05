import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DottedTriangle } from "@/components/DottedTriangle";
import { Logo } from "@/components/Logo";
import { Sidebar } from "@/components/Sidebar";
import { StatusBadge, statusBadgeKind } from "@/components/StatusBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BRAND_NAME } from "@/lib/brand";

// The redesign's shared pieces: brand name, logo, status badges, the dotted triangle, the theme
// toggle. tests/e2e/theme.spec.ts checks them in a real browser, in both themes.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  usePathname: () => "/",
}));

const SRC = join(import.meta.dirname, "..", "apps", "web", "src");

describe("the brand name", () => {
  it("is GetPaid", () => {
    expect(BRAND_NAME).toBe("GetPaid");
  });

  it("is what the logo says", () => {
    expect(renderToStaticMarkup(createElement(Logo))).toContain(`>${BRAND_NAME}<`);
  });

  it("is what the sidebar shows, and the old name is gone", () => {
    const html = renderToStaticMarkup(createElement(Sidebar));
    expect(html).toContain(`>${BRAND_NAME}<`);
    expect(html).not.toContain("Payment Recovery");
  });

  it("gives the page its title from the constant", () => {
    const layout = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("title: BRAND_NAME");
    expect(layout).not.toContain("Payment Recovery");
  });
});

describe("the bottom bar", () => {
  it("keeps Home, Outbox, Clients and More for phones", () => {
    const html = renderToStaticMarkup(createElement(Sidebar));
    const phone = [...html.matchAll(/<li(?: class="([^"]*)")?>.*?<\/li>/g)]
      .filter(([, className]) => className !== "desktop-only")
      .map(([item]) => item.replace(/<[^>]+>/g, ""));
    expect(phone).toEqual(["Home", "Outbox", "Clients", "More"]);
  });
});

describe("the logo", () => {
  it("is a triangle drawn as a shape, so it can carry an outline in light mode", () => {
    const html = renderToStaticMarkup(createElement(Logo));
    expect(html).toContain('class="logo-mark"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain("<path");
  });
});

describe("status badges", () => {
  it.each([
    ["paid", "paid"],
    ["overdue", "overdue"],
    ["sent", "sent"],
    ["invoiced", "sent"],
    ["partially_paid", "sent"],
    ["disputed", "sent"],
    ["in_progress", "sent"],
    ["draft", "draft"],
    ["planned", "draft"],
    ["cancelled", "draft"],
  ])("%s looks like %s", (status, kind) => {
    expect(statusBadgeKind(status)).toBe(kind);
  });

  it("treats a status it doesn't know as a plain one, never as Paid", () => {
    expect(statusBadgeKind("something_new")).toBe("sent");
  });

  it("always carries its label, so colour isn't the only signal", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { status: "paid", children: "Paid in full" }),
    );
    expect(html).toBe('<span class="badge badge-paid">Paid in full</span>');
  });
});

describe("the dotted triangle", () => {
  const draw = (props: Parameters<typeof DottedTriangle>[0]) =>
    renderToStaticMarkup(createElement(DottedTriangle, props));

  it("is hidden from screen readers", () => {
    expect(draw({ size: 100 })).toContain('aria-hidden="true"');
  });

  it("is about 0.9 as tall as it is wide", () => {
    const html = draw({ size: 200 });
    expect(html).toContain("width:200px");
    expect(html).toContain("height:180px");
  });

  it("takes a rotation, an opacity and a position", () => {
    const html = draw({ size: 100, rotate: 24, opacity: 0.3, right: -40, bottom: 12 });
    expect(html).toContain("rotate:24deg");
    expect(html).toContain("opacity:0.3");
    expect(html).toContain("right:-40px");
    expect(html).toContain("bottom:12px");
  });

  it("uses yellow dots by default, and black ones for the yellow band", () => {
    expect(draw({ size: 100 })).toContain('class="dot-tri"');
    expect(draw({ size: 100, variant: "ink" })).toContain('class="dot-tri ink"');
  });

  it("marks only the ones that should drift on scroll", () => {
    expect(draw({ size: 100 })).not.toContain("data-parallax");
    expect(draw({ size: 100, parallax: true })).toContain("data-parallax");
  });
});

describe("the theme toggle", () => {
  it("is a named button with both icons, before the theme is known", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Switch colour theme"');
    expect(html).toContain("theme-icon-sun");
    expect(html).toContain("theme-icon-moon");
  });
});
