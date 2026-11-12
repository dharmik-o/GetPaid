import sectionsFile from "@/content/help-sections.json";

// Picks the manual sections that best fit a question, with BM25 over plain keywords: no embeddings,
// no service, nothing sent anywhere. The manual is split by heading into
// apps/web/src/content/help-sections.json (npm run help:sections).

export type HelpSection = { id: string; title: string; path: string[]; text: string };

export const HELP_SECTIONS: readonly HelpSection[] = sectionsFile;

const STOP_WORDS = new Set(
  (
    "a an the is are was were be been am do does did done i me my mine we our you your it its in on of " +
    "for to from and or but if so as at by with about into out up not no there their they them this " +
    "that these those what why how where when which who whom can could should would will shall may " +
    "might must have has had get gets got go goes going want need please tell show give also any some " +
    "more than then just very too much many one"
  ).split(" "),
);

/** Lower-cased words, without small words, with a simple ending removed (emails and email match). */
export const tokens = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => {
      if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
      if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
      if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith("ed")) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
      return word;
    });

const K1 = 1.5;
const B = 0.75;
/** A word in a heading counts this many times: the heading says what the section is about. */
const TITLE_WEIGHT = 3;

type Indexed = { section: HelpSection; counts: Map<string, number>; length: number };

const indexOf = (sections: readonly HelpSection[]) => {
  const docs: Indexed[] = sections.map((section) => {
    const words = [
      ...Array.from({ length: TITLE_WEIGHT }, () => tokens(section.path.join(" "))).flat(),
      ...tokens(section.text),
    ];
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { section, counts, length: words.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const containing = new Map<string, number>();
  for (const doc of docs) {
    for (const word of doc.counts.keys()) containing.set(word, (containing.get(word) ?? 0) + 1);
  }
  return { docs, average, containing };
};

const defaultIndex = indexOf(HELP_SECTIONS);

export type ScoredSection = { section: HelpSection; score: number };

/** The best `limit` sections for a question, best first. Sections with no matching word are left out. */
export const retrieveSections = (
  question: string,
  { limit = 5, sections }: { limit?: number; sections?: readonly HelpSection[] } = {},
): ScoredSection[] => {
  const { docs, average, containing } = sections ? indexOf(sections) : defaultIndex;
  const words = [...new Set(tokens(question))];
  const scored = docs.map(({ section, counts, length }) => {
    let score = 0;
    for (const word of words) {
      const frequency = counts.get(word) ?? 0;
      if (frequency === 0) continue;
      const have = containing.get(word) ?? 0;
      const idf = Math.log(1 + (docs.length - have + 0.5) / (have + 0.5));
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / average));
    }
    return { section, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};
