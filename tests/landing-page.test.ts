import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// GSAP is for the landing page only: the brief keeps the app's own pages calm, so it must never
// reach their bundles.

const SOURCE = "apps/web/src";

const filesUnder = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const sources = filesUnder(SOURCE).filter((path) => /\.tsx?$/.test(path));
const importsGsap = (path: string): boolean =>
  /from "gsap|import\("gsap/.test(readFileSync(path, "utf8"));
const shortPath = (path: string): string => relative(SOURCE, path).replaceAll("\\", "/");

describe("the landing page's motion", () => {
  it("is the only code that imports GSAP", () => {
    expect(sources.filter(importsGsap).map(shortPath)).toEqual([
      "components/landing/LandingMotion.tsx",
    ]);
  });

  it("only moves things when reduced motion is off", () => {
    const motion = readFileSync(join(SOURCE, "components/landing/LandingMotion.tsx"), "utf8");
    expect(motion).toContain("(prefers-reduced-motion: no-preference)");
    expect(motion).toContain("gsap.matchMedia");
    expect(motion).toContain(".revert()");
  });
});

describe("the landing page's words", () => {
  const landing = sources
    .filter((path) => shortPath(path).startsWith("components/landing/"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  it("takes the product's name from the one constant", () => {
    expect(landing).toContain("BRAND_NAME");
    expect(landing).not.toContain(">GetPaid<");
  });

  it("writes money with a currency code, and has no invented claims", () => {
    expect(landing).not.toContain("₹");
    expect(landing).not.toMatch(/\$\d/);
    expect(landing).not.toMatch(/trusted by|testimonial|per month/i);
  });
});
