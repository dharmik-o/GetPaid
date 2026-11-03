import { readFileSync } from "node:fs";
import { join } from "node:path";

// The prompts in prompts/*.md are the source. The app can't read files outside apps/web at
// run time in every setup, so `npm run ai:prompts` writes them into lib/prompt-text.ts, and
// tests/prompts.test.ts fails if the two drift.

export const PROMPTS_DIR = join(import.meta.dirname, "..", "..", "prompts");
export const PROMPT_MODULE = join(
  import.meta.dirname,
  "..",
  "..",
  "apps",
  "web",
  "src",
  "lib",
  "prompt-text.ts",
);

/** The drafting prompts the app uses (M7 adds classify_reply, M6 redraft_from_feedback). */
export const PROMPT_FILES = [
  "courtesy_pre_due",
  "tier1_friendly",
  "tier2_firm",
  "tier3_final_notice",
  "maintenance_heads_up",
] as const;

/** A prompt file without its title line. */
export const promptBody = (name: string): string => {
  const text = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").replace(/\r\n/g, "\n");
  const body = text.replace(/^# .*\n/, "").trim();
  if (!body) throw new Error(`prompts/${name}.md has no prompt text. Write it under the title.`);
  return body;
};

export const promptModuleSource = (): string => {
  const entries = PROMPT_FILES.map((name) => `  ${name}: ${JSON.stringify(promptBody(name))},`);
  return [
    "// Generated from prompts/*.md by `npm run ai:prompts`; don't edit by hand.",
    "// tests/prompts.test.ts fails if this file and the prompts drift.",
    "",
    "export const PROMPT_TEXT = {",
    ...entries,
    "} as const;",
    "",
    "export type PromptName = keyof typeof PROMPT_TEXT;",
    "",
  ].join("\n");
};
