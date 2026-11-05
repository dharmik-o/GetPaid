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
  ["the logo on the page", "logo-ink", "bg"],
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
});

// WCAG sets no ratio for a card's edge, as it isn't a control. In light mode --line is a hairline and
// the shadows do the separating. These floors only catch a line that vanishes.
describe("card and table borders", () => {
  it.each(["surface", "bg"])("don't vanish on %s in light mode", (fill) => {
    expect(contrast(LIGHT.line ?? "", LIGHT[fill] ?? "")).toBeGreaterThanOrEqual(1.1);
  });

  it.each(["surface", "bg"])("don't vanish on %s in dark mode", (fill) => {
    expect(contrast(DARK.line ?? "", DARK[fill] ?? "")).toBeGreaterThanOrEqual(1.2);
  });
});

describe("shadows", () => {
  const SHADOWS = [
    "shadow-card",
    "shadow-card-hover",
    "shadow-panel",
    "shadow-control",
    "shadow-button",
    "shadow-pop",
  ];
  const valueIn = (block: string, name: string): string =>
    (new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const dark = (name: string) => valueIn(blockAfter(":root {"), name);
  const light = (name: string) => valueIn(blockAfter('[data-theme="light"] {'), name);

  it.each(SHADOWS)("--%s in light mode is a soft warm shadow, never a coloured glow", (name) => {
    const value = light(name);
    expect(value).toMatch(/rgba\(20, 18, 10, 0\.\d+\)/);
    expect(value.replace(/rgba\(20, 18, 10, 0\.\d+\)/g, "")).not.toMatch(/rgb|#/);
  });

  it("makes inputs look recessed in light mode", () => {
    expect(light("shadow-control")).toMatch(/^inset /);
  });

  it("lifts a card further on hover than at rest", () => {
    expect(light("shadow-card-hover")).not.toBe(light("shadow-card"));
  });

  it.each(["shadow-card", "shadow-panel"])("--%s in dark mode is a faint top highlight", (name) => {
    expect(dark(name)).toBe("inset 0 1px 0 rgba(255, 255, 255, 0.04)");
  });

  it("makes the highlight a little stronger on hover in dark mode", () => {
    expect(dark("shadow-card-hover")).toBe("inset 0 1px 0 rgba(255, 255, 255, 0.06)");
  });

  it.each(["shadow-control", "shadow-button"])("--%s is off in dark mode", (name) => {
    expect(dark(name)).toBe("none");
  });

  it("gives popups an edge and a drop in dark mode", () => {
    expect(dark("shadow-pop")).toBe("0 0 0 1px #2c2c2c, 0 24px 48px rgba(0, 0, 0, 0.6)");
  });

  it("never gives the primary button a soft shadow: only the hard offset on hover", () => {
    const rest = /\n\.button \{[^}]*\}/.exec(CSS)?.[0] ?? "";
    expect(rest).toContain("display: inline-flex");
    expect(rest).not.toContain("box-shadow:");
    expect(/\n\.button:hover \{[^}]*\}/.exec(CSS)?.[0]).toContain("0 6px 0 0 var(--text)");
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

  it("has a true black page in dark mode, and white cards on a warm page in light mode", () => {
    expect(DARK.bg).toBe("#000000");
    expect(DARK.surface).toBe("#141414");
    expect(LIGHT.bg).toBe("#f5f4f0");
    expect(LIGHT.surface).toBe("#ffffff");
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
    expect(blockAfter("\n.dot-tri {")).toContain("radial-gradient(");
  });

  it("has soft shadows only through the tokens: any other box-shadow is a hard edge", () => {
    const shadows = [...CSS.matchAll(/box-shadow:\s*([^;]+);/g)].map(([, value = ""]) => value);
    expect(shadows.length).toBeGreaterThan(0);
    for (const shadow of shadows) {
      for (const layer of shadow.split(",")) {
        if (layer.trim() === "none" || layer.trim().startsWith("var(--shadow-")) continue;
        const blur = /(?:inset\s+)?-?\d+(?:px)?\s+-?\d+(?:px)?\s+(-?[\d.]+)/.exec(layer.trim());
        expect(blur?.[1], `blur in "${layer.trim()}"`).toBe("0");
      }
    }
  });

  it("turns off movement for people who ask for reduced motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
