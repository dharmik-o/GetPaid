import type { z } from "zod";

/** One problem, tied to the form field it belongs to (a dot path, e.g. `tierBoundaries.tier2`). */
export type FieldIssue = { field: string; message: string };

type Options = {
  /** Nests every field under this path, e.g. `settings`. */
  prefix?: string;
  /** What a field is called in messages: "setting" or "field". */
  noun?: string;
};

const joinPath = (prefix: string, path: readonly PropertyKey[]): string =>
  [prefix, ...path.map(String)].filter(Boolean).join(".");

/** zod issues as field issues. Unknown keys are reported by name; whole-object issues get the noun. */
export const toFieldIssues = (
  error: z.ZodError,
  { prefix = "", noun = "setting" }: Options = {},
): FieldIssue[] =>
  error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        field: joinPath(prefix, [...issue.path, key]),
        message: `isn't a known ${noun}`,
      }));
    }
    return [{ field: joinPath(prefix, issue.path) || `${noun}s`, message: issue.message }];
  });
