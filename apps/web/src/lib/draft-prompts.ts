import type { ChatMessage } from "./ai-client";
import type { DraftKind, DraftRequest } from "./draft-facts";
import { PROMPT_TEXT, type PromptName } from "./prompt-text";

// The messages sent to the AI router for a draft: the prompt from prompts/*.md as the system
// message and the facts as quoted JSON data. Pure.

export const PROMPT_FOR: Readonly<Record<DraftKind, PromptName>> = {
  courtesy: "courtesy_pre_due",
  tier1: "tier1_friendly",
  tier2: "tier2_firm",
  tier3: "tier3_final_notice",
  maintenance: "maintenance_heads_up",
};

/** Only Tier 3 is ever shown a citation. */
const factsFor = (request: DraftRequest): object => {
  if (request.kind === "maintenance" || request.kind === "tier3") return request.facts;
  return Object.fromEntries(Object.entries(request.facts).filter(([key]) => key !== "citation"));
};

/** "<" becomes the JSON escape u003c, so text inside a fact can't close the <facts> tag. */
const quoted = (value: object): string =>
  JSON.stringify(value).replace(/</g, `${String.fromCharCode(92)}u003c`);

export const draftMessages = (request: DraftRequest): ChatMessage[] => [
  { role: "system", content: PROMPT_TEXT[PROMPT_FOR[request.kind]] },
  { role: "user", content: `<facts>${quoted(factsFor(request))}</facts>` },
];
