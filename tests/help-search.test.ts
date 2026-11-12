import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isHowToQuestion } from "@/lib/help-assistant";
import { allowedLinks, HELP_ROUTES } from "@/lib/help-links";
import { HELP_SECTIONS, retrieveSections, tokens } from "@/lib/help-search";
import { parseManual, SECTIONS_FILE, sectionsFileSource } from "../scripts/lib/help-source";

// E3: the manual is cut into sections by heading, the best few are picked for a question with plain
// keyword scoring, and a how-to question is told apart from a calendar one.

const top = (question: string, limit = 5) =>
  retrieveSections(question, { limit }).map((entry) => entry.section.id);

describe("the sections file", () => {
  it("matches docs/help/manual.md (run npm run help:sections)", () => {
    const saved = readFileSync(SECTIONS_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(saved).toBe(sectionsFileSource());
  });

  it("has a section for each new way to close, cancel, complete, archive and delete", () => {
    const titles = HELP_SECTIONS.map((section) => section.title);
    for (const wanted of [
      /^Record a payment/,
      /^Cancel an invoice$/,
      /^Complete a project$/,
      /^Archive or delete a project$/,
      /^Ask GetPaid/,
    ]) {
      expect(
        titles.some((title) => wanted.test(title)),
        String(wanted),
      ).toBe(true);
    }
  });

  it("has unique ids and keeps every section small enough to send", () => {
    const ids = HELP_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...HELP_SECTIONS.map((section) => section.text.length))).toBeLessThan(4000);
  });
});

describe("parseManual", () => {
  const SAMPLE = [
    "# Manual (help text)",
    "",
    "Intro for people.",
    "",
    "**Chapter 1**",
    "",
    "# Getting started",
    "",
    "Open the app.",
    "",
    "## Add a \\[client\\]",
    "",
    "Press **Add client**.",
    "",
    "### Details",
    "",
    "Fill in the name.",
    "",
    "## Add a [client]",
    "",
    "Second one.",
  ].join("\n");

  it("cuts by heading, keeps the path, drops chapter labels, unescapes, and makes ids unique", () => {
    const sections = parseManual(
      SAMPLE.replace("# Manual (help text)", "# GetPaid user manual (help text)"),
    );
    expect(sections.map((s) => [s.id, s.path])).toEqual([
      ["getting-started", ["Getting started"]],
      ["getting-started--add-a-client", ["Getting started", "Add a [client]"]],
      ["getting-started--add-a-client--details", ["Getting started", "Add a [client]", "Details"]],
      ["getting-started--add-a-client-2", ["Getting started", "Add a [client]"]],
    ]);
    expect(sections[0]?.text).toBe("Open the app.");
    expect(sections.every((s) => !s.text.includes("Chapter 1"))).toBe(true);
  });
});

describe("retrieveSections", () => {
  it("finds 'Who can receive emails' for a question about a second account", () => {
    expect(top("why do emails go to my second account")[0]).toBe("who-can-receive-emails");
  });

  it("finds the record-a-payment section for the bank transfer question", () => {
    expect(top("How do I record a bank transfer?", 3).join(" ")).toContain("record-a-payment");
  });

  it("finds Telegram and reminders sections for the other suggestions", () => {
    expect(top("How do I connect Telegram?", 3).join(" ")).toMatch(/telegram/);
    expect(top("How do reminders work?").join(" ")).toMatch(/reminder|outbox|escalat/);
  });

  it("returns at most the limit, best first, and nothing for words the manual lacks", () => {
    const scored = retrieveSections("reminder email schedule", { limit: 4 });
    expect(scored.length).toBeLessThanOrEqual(4);
    expect(scored.map((entry) => entry.score)).toEqual(
      [...scored.map((entry) => entry.score)].sort((a, b) => b - a),
    );
    expect(retrieveSections("zzqx qwvb")).toEqual([]);
    expect(retrieveSections("how do i")).toEqual([]);
  });

  it("treats plurals and endings alike", () => {
    expect(tokens("Emails sending reminders")).toEqual(tokens("email send reminder"));
  });
});

describe("isHowToQuestion", () => {
  it.each([
    "How do I record a bank transfer?",
    "How do I connect Telegram?",
    "How do reminders work?",
    "Why do emails go to my second account?",
    "Where do I change my AI model?",
    "What does Partially paid mean?",
  ])("%s is about the app", (question) => {
    expect(isHowToQuestion(question)).toBe(true);
  });

  it.each([
    "What's on my calendar next week?",
    "What is due this week?",
    "How many calls do I have on Friday?",
    "How do I move my call to Friday?",
    "When is the Acme deadline?",
    "Plan my Friday",
    "What is overdue?",
  ])("%s stays with the calendar", (question) => {
    expect(isHowToQuestion(question)).toBe(false);
  });
});

describe("allowedLinks", () => {
  it("keeps only exact routes from the list, once each, with their labels", () => {
    expect(
      allowedLinks([
        "/settings/ai",
        "/settings/ai",
        "/etc/passwd",
        "https://evil.example/settings/ai",
        "javascript:alert(1)",
        "/settings/ai/",
        "/projects/new?x=1",
        "/projects/new",
        "__proto__",
        "constructor",
      ]),
    ).toEqual([
      { href: "/settings/ai", label: "Settings > AI" },
      { href: "/projects/new", label: "New project" },
    ]);
  });

  it("only lists routes that exist as pages", () => {
    for (const href of Object.keys(HELP_ROUTES)) {
      const page = href === "/" ? "page.tsx" : `${href.slice(1)}/page.tsx`;
      expect(() =>
        readFileSync(new URL(`../apps/web/src/app/${page}`, import.meta.url)),
      ).not.toThrow();
    }
  });
});
