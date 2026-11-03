import { writeFileSync } from "node:fs";
import {
  PROMPT_MODULE,
  promptModuleSource,
  STATUTE_MODULE,
  statuteModuleSource,
} from "./lib/prompt-source";

// Writes lib/prompt-text.ts from prompts/*.md and lib/statute-table.ts from legal/statutes.json.
// Run after editing a prompt or the law table.
for (const [file, source] of [
  [PROMPT_MODULE, promptModuleSource()],
  [STATUTE_MODULE, statuteModuleSource()],
] as const) {
  writeFileSync(file, source);
  process.stdout.write(`wrote ${file}${String.fromCharCode(10)}`);
}
