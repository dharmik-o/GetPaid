import { writeFileSync } from "node:fs";
import { PROMPT_MODULE, promptModuleSource } from "./lib/prompt-source";

// Writes apps/web/src/lib/prompt-text.ts from prompts/*.md. Run after editing a prompt.
writeFileSync(PROMPT_MODULE, promptModuleSource());
process.stdout.write(`wrote ${PROMPT_MODULE}\n`);
