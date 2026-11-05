import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Server-only: the fonts an invoice document may use, embedded in it as data. A PDF is made with the
// network off and a template can't load anything, so @font-face rules come from here, not from the
// template, and only for the families its CSS names. All are from @fontsource, under the OFL.

type Face = { package: string; file: string; weights: readonly number[] };

const FACES: Readonly<Record<string, Face>> = {
  "Instrument Sans": {
    package: "instrument-sans",
    file: "instrument-sans",
    weights: [400, 500, 600, 700],
  },
  "IBM Plex Mono": { package: "ibm-plex-mono", file: "ibm-plex-mono", weights: [400, 500, 600] },
  "IBM Plex Sans": {
    package: "ibm-plex-sans",
    file: "ibm-plex-sans",
    weights: [300, 400, 500, 600, 700],
  },
  "IBM Plex Serif": { package: "ibm-plex-serif", file: "ibm-plex-serif", weights: [400, 600, 700] },
  "Mrs Saint Delafield": {
    package: "mrs-saint-delafield",
    file: "mrs-saint-delafield",
    weights: [400],
  },
};

export const DOCUMENT_FONT_FAMILIES: readonly string[] = Object.keys(FACES);

/** Plain Latin and accented Latin load as separate files, each for its own characters. */
const SUBSETS = [
  {
    subset: "latin",
    range:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    subset: "latin-ext",
    range:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
] as const;

/** node_modules sits at the repo root, above the web app. Found from wherever the app runs. */
const findFontFile = (relative: string): string => {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@fontsource", relative);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) {
      throw new Error(`The font file ${relative} is missing. Run npm install, then try again.`);
    }
  }
};

const cache = new Map<string, string>();

const fontFaces = (family: string, face: Face): string => {
  const cached = cache.get(family);
  if (cached !== undefined) return cached;
  const rules = face.weights.flatMap((weight) =>
    SUBSETS.map(({ subset, range }) => {
      const file = findFontFile(
        join(face.package, "files", `${face.file}-${subset}-${String(weight)}-normal.woff2`),
      );
      const data = readFileSync(file).toString("base64");
      return `@font-face{font-family:"${family}";font-style:normal;font-weight:${String(weight)};src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range}}`;
    }),
  );
  const css = rules.join("");
  cache.set(family, css);
  return css;
};

/** @font-face rules for each family the template's CSS names; empty when it names none of them. */
export const documentFontCss = (templateCss: string): string =>
  Object.entries(FACES)
    .filter(([family]) => templateCss.includes(family))
    .map(([family, face]) => fontFaces(family, face))
    .join("");
