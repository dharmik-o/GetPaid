import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "./contrast";

// docs/DESIGN.md asks for WCAG AA in both themes. These read the tokens from globals.css, so a
// colour change that breaks contrast fails here. tests/e2e/theme.spec.ts measures the real pages.

const CSS = readFileSync(
  join(import.meta.dirname, "..", "apps", "web", "src", "app", "globals.css"),
  "utf8",
);

type Tokens = Record<string, string>;

const tokensIn = (block: string): Tokens =>
  Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name = "", value = ""]) => [
      name,
      value,
    ]),
  );

const blockAfter = (marker: string): string => {
  const start = CSS.indexOf(marker);
  if (start < 0) throw new Error(`globals.css has no "${marker}".`);
  return CSS.slice(start, CSS.indexOf("}", start));
};

const DARK = tokensIn(blockAfter(":root {"));
const LIGHT = { ...DARK, ...tokensIn(blockAfter('[data-theme="light"] {')) };

const SURFACES = ["bg", "surface", "surface-2"];

const onEverySurface = (what: string, token: string): [string, string, string][] =>
  SURFACES.map((fill) => [`${what} on ${fill}`, token, fill]);

const TEXT_PAIRS: [string, string, string][] = [
  ["primary button", "on-accent", "accent"],
  ["primary button, hover", "on-accent", "accent-hover"],
  ["primary button, pressed", "on-accent", "accent-press"],
  ...onEverySurface("body text and secondary buttons", "text"),
  ...onEverySurface("muted text and disabled buttons", "muted"),
  ...onEverySurface("yellow text and links", "accent-ink"),
  ...onEverySurface("danger text and buttons", "danger"),
];

const OUTLINE_PAIRS: [string, string, string][] = [
  ...onEverySurface("focus ring", "focus"),
  // Every input, select, secondary button and toggle sits on one of these, or is filled with one.
  ...onEverySurface("control border", "line-control"),
  ["danger border on a card", "danger", "surface"],
];

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
])("the %s theme", (_name, tokens) => {
  const color = (name: string): string => {
    const value = tokens[name];
    if (!value) throw new Error(`The theme has no --${name} token.`);
    return value;
  };

  it.each(TEXT_PAIRS)("%s text meets AA, 4.5:1", (_what, text, fill) => {
    expect(contrast(color(text), color(fill))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(OUTLINE_PAIRS)("%s meets 3:1", (_what, line, fill) => {
    expect(contrast(color(line), color(fill))).toBeGreaterThanOrEqual(3);
  });

  // WCAG sets no ratio for a card's edge, as it isn't a control. The redesign's --line is the mock's
  // own value, and a card also stands out by its fill, so this floor only catches a line that vanishes.
  it.each([
    ["a card", "surface"],
    ["the page", "bg"],
  ])("the card and table border is visible on %s", (_where, fill) => {
    expect(contrast(color("line"), color(fill))).toBeGreaterThanOrEqual(1.2);
  });
});

describe("yellow fills", () => {
  it("show up by themselves on black", () => {
    expect(contrast(DARK.accent ?? "", DARK.bg ?? "")).toBeGreaterThanOrEqual(3);
  });

  it("need the black edge on white, and have it", () => {
    expect(contrast(LIGHT.accent ?? "", LIGHT.bg ?? "")).toBeLessThan(3);
    expect(contrast(LIGHT.edge ?? "", LIGHT.bg ?? "")).toBeGreaterThanOrEqual(3);
  });

  it("carry black text in both themes", () => {
    expect(DARK["on-accent"]).toBe("#000000");
    expect(LIGHT["on-accent"]).toBe("#000000");
  });
});

describe("the themes", () => {
  it("has its own light colours, and tells the browser about both", () => {
    expect(DARK.surface).not.toBe(LIGHT.surface);
    expect(blockAfter(":root {")).toMatch(/color-scheme:\s*dark/);
    expect(blockAfter('[data-theme="light"] {')).toMatch(/color-scheme:\s*light/);
  });

  it("uses true black and white for the page", () => {
    expect(DARK.bg).toBe("#000000");
    expect(LIGHT.bg).toBe("#ffffff");
  });

  it("doesn't fade disabled buttons, which would break their contrast", () => {
    expect(CSS).not.toMatch(/:disabled[^{]*\{[^}]*opacity/);
  });

  it("keeps colours in tokens, apart from the white paper behind an invoice preview", () => {
    const rules = CSS.slice(CSS.indexOf("* {"));
    const stray = [...rules.matchAll(/([^{}]+)\{[^}]*#[0-9a-f]{3,6}\b[^}]*\}/gi)].map(
      ([, selector = ""]) => selector.trim(),
    );
    expect(stray).toEqual([".template-preview"]);
  });

  it("has one gradient: the dot pattern in the dotted triangle", () => {
    const gradients = [...CSS.matchAll(/[\w-]*gradient\(/g)].map(([name]) => name);
    expect(gradients).toEqual(["radial-gradient("]);
    expect(blockAfter(".dot-tri {")).toContain("radial-gradient(");
  });

  it("has no glows or soft shadows: every box-shadow is a hard edge, with no blur", () => {
    const shadows = [...CSS.matchAll(/box-shadow:\s*([^;]+);/g)].map(([, value = ""]) => value);
    expect(shadows.length).toBeGreaterThan(0);
    for (const shadow of shadows) {
      for (const layer of shadow.split(",")) {
        if (layer.trim() === "none") continue;
        const blur = /(?:inset\s+)?-?\d+(?:px)?\s+-?\d+(?:px)?\s+(-?[\d.]+)/.exec(layer.trim());
        expect(blur?.[1], `blur in "${layer.trim()}"`).toBe("0");
      }
    }
  });

  it("turns off movement for people who ask for reduced motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
