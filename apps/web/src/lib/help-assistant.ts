import { routeTask } from "./ai-router";
import { helpAnswerSchema } from "./ai-schemas";
import { loadAiConnections, type AiConnection } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { allowedLinks, type HelpLink } from "./help-links";
import { retrieveSections, type HelpSection } from "./help-search";
import { PROMPT_TEXT } from "./prompt-text";
import { safeText } from "./quoted-text";

// Server-only: "Ask GetPaid". It answers how-to questions from the manual and nothing else. The
// manual is trusted text; the question is untrusted and is quoted data for the model. The model can
// only explain: it has no way to change data, and every answer is checked in code (the schema, the
// section ids it names, the links it offers). The question and the answer are never logged.

export const NO_MODEL = "Set a model in Settings > AI, then ask again.";
export const FAILED =
  "I couldn't get a reliable answer from your AI model. Try again, or download the manual (PDF).";
/** When the model fails, the closest part of the manual is shown instead, cut to this length. */
const FALLBACK_CHARS = 900;
const MAX_SOURCES = 6;
export const NOT_IN_MANUAL =
  "I couldn't find that in the manual. Download the manual (PDF) to look it up yourself.";

/** How many sections go to the model, and how much of each. */
const SECTIONS_TO_SEND = 5;
const MAX_SECTION_CHARS = 2600;

export type HelpAnswer = {
  answer: string;
  sources: { id: string; title: string }[];
  links: HelpLink[];
  /** True when the AI model failed and the answer is the closest manual section, as written. */
  fromManual?: boolean;
};

export type HelpResult =
  ({ ok: true } & HelpAnswer) | { ok: false; error: string; reason: "no_model" | "failed" };

export type HelpDeps = {
  runAsUser: UserDbRunner;
  box: () => SecretBox;
  /** Replaceable in tests; the real one calls the user's model through the router. */
  route?: typeof routeTask;
};

/** Section text for the model: no tag can be opened or closed from inside it. */
const sectionBlock = (section: HelpSection): string =>
  `<section id="${section.id}">${section.path.join(" > ")}\n${section.text
    .slice(0, MAX_SECTION_CHARS)
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</section>`;

export const helpMessages = (
  sections: readonly HelpSection[],
  question: string,
): { role: "system" | "user"; content: string }[] => [
  { role: "system", content: PROMPT_TEXT["help-assistant"] },
  {
    role: "user",
    content: [
      "<manual>",
      ...sections.map(sectionBlock),
      "</manual>",
      `<question>${safeText(question)}</question>`,
    ].join("\n"),
  },
];

/** The help task's models, or the main model's (the draft task) when none was saved for help. */
const connectionsFor = async (db: Db, box: SecretBox): Promise<AiConnection[]> => {
  const own = await loadAiConnections(db, "help", box);
  return own.length > 0 ? own : loadAiConnections(db, "draft", box);
};

/** The model's answer, checked: sources only from what it was given, links only from the allowlist. */
export const checkHelpAnswer = (
  raw: { answer: string; sources: string[]; links: string[] },
  given: readonly HelpSection[],
): HelpAnswer => {
  const byId = new Map(given.map((section) => [section.id, section]));
  const sources = [...new Set(raw.sources)]
    .flatMap((id) => {
      const section = byId.get(id);
      return section ? [{ id, title: section.title }] : [];
    })
    .slice(0, MAX_SOURCES);
  return { answer: raw.answer.trim(), sources, links: allowedLinks(raw.links) };
};

/** Cut at a paragraph or sentence end before the limit, so the excerpt reads as whole text. */
const excerpt = (text: string, limit: number): string => {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const end = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${(end > limit / 2 ? cut.slice(0, end + 1) : cut).trimEnd()} …`;
};

/** The model failed: show the best-matching manual section itself, so the question still gets help. */
export const manualFallback = (section: HelpSection): HelpAnswer => ({
  answer: [
    "Your AI model didn't answer this time, so here's the closest part of the manual.",
    section.path.join(" > "),
    excerpt(section.text, FALLBACK_CHARS),
  ].join("\n\n"),
  sources: [{ id: section.id, title: section.title }],
  links: [],
  fromManual: true,
});

export const askHelp = async (deps: HelpDeps, question: string): Promise<HelpResult> => {
  const sections = retrieveSections(question, { limit: SECTIONS_TO_SEND }).map(
    (entry) => entry.section,
  );
  const connections = await deps.runAsUser((db) => connectionsFor(db, deps.box()));
  if (connections.length === 0) return { ok: false, error: NO_MODEL, reason: "no_model" };
  // Nothing in the manual shares a word with the question: say so, without asking a model.
  if (sections.length === 0) return { ok: true, answer: NOT_IN_MANUAL, sources: [], links: [] };
  // The model call runs outside any transaction: a local model can take a minute.
  const result = await (deps.route ?? routeTask)(connections, {
    messages: helpMessages(sections, question),
    schema: helpAnswerSchema,
  });
  if (!result.ok) {
    const best = sections[0];
    return best
      ? { ok: true, ...manualFallback(best) }
      : { ok: false, error: FAILED, reason: "failed" };
  }
  return { ok: true, ...checkHelpAnswer(result.output, sections) };
};

// Telling a how-to question from a calendar one ---------------------------------------------------

const HOW_TO =
  /^\s*(how (do|can|could|should|would|does|to)\b|where (do|can|is|are)\b|what (does|is|are) (the |a |an )?\w+|why (do|does|are|is|did)\b|can i\b|is there a way\b)/i;

/** Words that make a question about the calendar's own items, dates or changes, not about the app. */
const CALENDAR_WORDS = new Set(
  (
    "calendar agenda schedule scheduled meeting meetings call calls event events entry entries " +
    "deadline deadlines due overdue today tomorrow yesterday tonight week weekend month next last " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april june " +
    "july august september october november december free busy move reschedule plan"
  ).split(" "),
);

/**
 * A question about using the app, not about the freelancer's calendar. A date, a day, a calendar
 * word or no how-to opening keeps the question with the calendar assistant.
 */
export const isHowToQuestion = (question: string): boolean => {
  if (!HOW_TO.test(question)) return false;
  const words = question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return !words.some((word) => CALENDAR_WORDS.has(word) || /^\d/.test(word));
};
