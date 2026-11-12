import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/help/manual.md is the source of the in-app help. It is cut into sections by heading, and
// `npm run help:sections` writes them to apps/web/src/content/help-sections.json, because the web
// app (and its Docker build) can't read docs/ at run time. tests/help-sections.test.ts fails if the
// two drift, the same way prompts/*.md and lib/prompt-text.ts are kept in step.

export const MANUAL_FILE = join(import.meta.dirname, "..", "..", "docs", "help", "manual.md");
export const SECTIONS_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "apps",
  "web",
  "src",
  "content",
  "help-sections.json",
);

export type HelpSectionSource = {
  id: string;
  title: string;
  /** The headings above it, outermost first, ending with its own title. */
  path: string[];
  text: string;
};

const HEADING = /^(#{1,3}) +(.+?)\s*#*$/;
/** "**Chapter 7**" and "**Appendix B**" lines only label the heading that follows. */
const CHAPTER_LABEL = /^\*\*(Chapter \d+|Appendix [A-Z])\*\*$/;

/** Markdown noise out of a heading or a line: escapes, bold marks and the PDF's stray ":**". */
const plain = (text: string): string =>
  text
    .replace(/\\([[\]<>_*#`|])/g, "$1")
    .replace(/:\*\*/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();

export const slug = (text: string): string =>
  plain(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const parseManual = (markdown: string): HelpSectionSource[] => {
  const sections: HelpSectionSource[] = [];
  const used = new Set<string>();
  const trail: string[] = [];
  let current: { title: string; path: string[]; lines: string[] } | undefined;

  const close = () => {
    if (!current) return;
    const text = current.lines
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text) {
      const base = current.path.map(slug).join("--");
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}-${String(n)}`;
      used.add(id);
      sections.push({ id, title: current.title, path: current.path, text });
    }
    current = undefined;
  };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const level = (heading[1] ?? "#").length;
      const title = plain(heading[2] ?? "");
      trail.length = level - 1;
      trail[level - 1] = title;
      current = { title, path: trail.filter((part) => Boolean(part)), lines: [] };
      continue;
    }
    if (CHAPTER_LABEL.test(line.trim())) continue;
    current?.lines.push(line);
  }
  close();
  // The file's own title and its note about screenshots are for people, not for answers.
  return sections.filter((section) => !section.title.startsWith("GetPaid user manual"));
};

export const readSections = (): HelpSectionSource[] =>
  parseManual(readFileSync(MANUAL_FILE, "utf8"));

export const sectionsFileSource = (): string => `${JSON.stringify(readSections(), null, 2)}\n`;
