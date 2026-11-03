import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_SCHEMA_NAMES,
  classificationSchema,
  draftSchema,
  jsonSchemaFor,
} from "@/lib/ai-schemas";

// The zod schemas and prompts/schemas/*.json must say the same thing: AI output is checked
// with zod, and the JSON files are what prompts and n8n refer to.

const fileFor = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "prompts", "schemas", `${name}.schema.json`),
      "utf8",
    ),
  );

describe("prompts/schemas", () => {
  it.each(AI_SCHEMA_NAMES)(
    "%s.schema.json matches the zod schema (run npm run ai:schemas)",
    (name) => {
      expect(fileFor(name)).toEqual(jsonSchemaFor(name));
    },
  );
});

describe("classificationSchema", () => {
  it("accepts a promise with its date", () => {
    expect(
      classificationSchema.safeParse({
        label: "promise",
        promisedDate: "2026-11-15",
        returnDate: null,
        summary: "Will pay on the 15th.",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an unknown label", { label: "paid", promisedDate: null, returnDate: null, summary: "x" }],
    ["a bad date", { label: "promise", promisedDate: "15 Nov", returnDate: null, summary: "x" }],
    ["a missing field", { label: "unclear", promisedDate: null, summary: "x" }],
    [
      "an extra field, such as a status change",
      { label: "unclear", promisedDate: null, returnDate: null, summary: "x", status: "paid" },
    ],
  ])("refuses %s", (_label, value) => {
    expect(classificationSchema.safeParse(value).success).toBe(false);
  });
});

describe("draftSchema", () => {
  it("needs a subject and a body, and nothing else", () => {
    expect(draftSchema.safeParse({ subject: "Invoice FPR-000001", body: "Hi" }).success).toBe(true);
    expect(draftSchema.safeParse({ subject: "", body: "Hi" }).success).toBe(false);
    expect(draftSchema.safeParse({ subject: "s", body: "b", send: true }).success).toBe(false);
  });
});
