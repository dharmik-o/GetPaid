import { formatDay } from "./format";

// What a reply's suggested action is, and what its button says. Pure: safe in client components.

export type ReplySuggestion =
  { kind: "pause"; until: string } | { kind: "split" } | { kind: "hold" };

export const primaryLabel = (suggestion: ReplySuggestion): string => {
  switch (suggestion.kind) {
    case "pause":
      return `Pause until ${formatDay(suggestion.until)}`;
    case "split":
      return "Review a split";
    case "hold":
      return "Keep on hold";
  }
};
