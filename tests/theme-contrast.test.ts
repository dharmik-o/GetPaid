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

const LIGHT = tokensIn(blockAfter(":root {"));
const DARK = { ...LIGHT, ...tokensIn(blockAfter("@media (prefers-color-scheme: dark)")) };

const TEXT_PAIRS: [string, string, string][] = [
  ["primary button", "on-accent", "accent"],
  ["primary button, hover", "on-accent", "accent-hover"],
  ["secondary button and links", "accent", "surface"],
  ["links on the page background", "accent", "background"],
  ["secondary button, hover", "accent", "accent-soft"],
  ["danger button", "danger", "surface"],
  ["danger button, hover", "danger", "danger-soft"],
  ["disabled button", "disabled-text", "disabled-fill"],
  ["body text", "text", "surface"],
  ["body text on the page background", "text", "background"],
  ["muted text", "text-muted", "surface"],
  ["muted text on the page background", "text-muted", "background"],
  ["error banner", "text", "danger-soft"],
  ["warning banner", "text", "warning-soft"],
  ["warning text", "warning-text", "surface"],
  ["preview panel", "text", "accent-soft"],
];

const OUTLINE_PAIRS: [string, string, string][] = [
  ["focus ring and primary fill on a card", "accent", "surface"],
  ["focus ring and primary fill on the page", "accent", "background"],
  ["button border on a card", "border-control", "surface"],
  ["button border on the page", "border-control", "background"],
  ["disabled button and field border", "border-control", "disabled-fill"],
  ["danger border", "danger", "surface"],
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

  // WCAG sets no ratio for a card's edge, as it isn't a control. 1.6:1 is this project's floor for
  // "visible": the old light border, at 1.35:1, was too faint to see on a laptop.
  it.each([
    ["a card", "surface"],
    ["the page", "background"],
  ])("the card and table border is visible on %s", (_where, fill) => {
    expect(contrast(color("border"), color(fill))).toBeGreaterThanOrEqual(1.6);
  });
});

describe("the themes", () => {
  it("has its own dark colours, and tells the browser about both", () => {
    expect(DARK.surface).not.toBe(LIGHT.surface);
    expect(CSS).toMatch(/color-scheme:\s*light dark/);
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
});
