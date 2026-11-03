import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AI_SCHEMA_NAMES, jsonSchemaFor, schemaFileName } from "../apps/web/src/lib/ai-schemas";

// Writes prompts/schemas/<name>.schema.json (kebab-case) from the zod schemas in lib/ai-schemas.ts.
// Run after changing a schema: npm run ai:schemas. tests/ai-schemas.test.ts fails until you do.

const dir = join(import.meta.dirname, "..", "prompts", "schemas");
for (const name of AI_SCHEMA_NAMES) {
  const file = join(dir, schemaFileName(name));
  writeFileSync(file, `${JSON.stringify(jsonSchemaFor(name), null, 2)}\n`);
  process.stdout.write(`wrote ${file}\n`);
}
