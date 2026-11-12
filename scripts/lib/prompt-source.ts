import { readFileSync } from "node:fs";
import { join } from "node:path";

// The prompts in prompts/*.md and the law table in legal/statutes.json are the source. The app can't read files outside apps/web at
// run time in every setup, so `npm run ai:prompts` writes them into lib/prompt-text.ts and
// lib/statute-table.ts and lib/reference-rate-table.ts, and tests fail if they drift.

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

export const STATUTES_FILE = join(import.meta.dirname, "..", "..", "legal", "statutes.json");
export const STATUTE_MODULE = join(PROMPT_MODULE, "..", "statute-table.ts");
export const RATES_FILE = join(import.meta.dirname, "..", "..", "legal", "reference-rates.json");
export const RATES_MODULE = join(PROMPT_MODULE, "..", "reference-rate-table.ts");

/** The prompts the app uses. */
export const PROMPT_FILES = [
  "courtesy_pre_due",
  "tier1_friendly",
  "tier2_firm",
  "tier3_final_notice",
  "final_demand",
  "maintenance_heads_up",
  "auto_pay_approval",
  "hold_approval",
  "invoice_text",
  "redraft_from_feedback",
  "classify_reply",
  "calendar_assistant",
  "help-assistant",
] as const;

/** A prompt file without its title line. */
export const promptBody = (name: string): string => {
  const text = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").replace(/\r\n/g, "\n");
  const body = text.replace(/^# .*\n/, "").trim();
  if (!body) throw new Error(`prompts/${name}.md has no prompt text. Write it under the title.`);
  return body;
};

export const promptModuleSource = (): string => {
  // A file name with a dash (help-assistant) can't be an unquoted key.
  const key = (name: string): string => (/^[A-Za-z_]\w*$/.test(name) ? name : JSON.stringify(name));
  const entries = PROMPT_FILES.map(
    (name) => `  ${key(name)}: ${JSON.stringify(promptBody(name))},`,
  );
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

export const readStatuteFile = (): unknown => JSON.parse(readFileSync(STATUTES_FILE, "utf8"));

export const statuteModuleSource = (): string =>
  [
    "// Generated from legal/statutes.json by `npm run ai:prompts`; don't edit by hand.",
    "// tests/legal.test.ts fails if this file and the table drift. Read it through lib/statutes.ts.",
    "",
    `export const STATUTE_TABLE: unknown = ${JSON.stringify(readStatuteFile(), null, 2)};`,
    "",
  ].join(String.fromCharCode(10));

export const readRatesFile = (): unknown => JSON.parse(readFileSync(RATES_FILE, "utf8"));

export const ratesModuleSource = (): string =>
  [
    "// Generated from legal/reference-rates.json by `npm run ai:prompts`; don't edit by hand.",
    "// tests/legal.test.ts fails if this file and the table drift. Read it through lib/statutes.ts.",
    "",
    `export const REFERENCE_RATE_TABLE: unknown = ${JSON.stringify(readRatesFile(), null, 2)};`,
    "",
  ].join(String.fromCharCode(10));
