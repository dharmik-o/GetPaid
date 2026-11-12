import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SECTIONS_FILE, sectionsFileSource } from "./lib/help-source";

// Writes apps/web/src/content/help-sections.json from docs/help/manual.md, one section per heading.
// Run after editing the manual: npm run help:sections. tests/help-sections.test.ts fails until you do.

mkdirSync(dirname(SECTIONS_FILE), { recursive: true });
writeFileSync(SECTIONS_FILE, sectionsFileSource());
process.stdout.write(`wrote ${SECTIONS_FILE}\n`);
