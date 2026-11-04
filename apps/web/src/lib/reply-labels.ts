import type { Classification } from "./ai-schemas";
import { formatDay } from "./format";

// What a reply's suggested action is, and what its button says. Pure: safe in client components.

export type ReplySuggestion =
  { kind: "pause"; until: string } | { kind: "split" } | { kind: "hold" };

export const REPLY_LABEL_NAMES: Record<Classification["label"], string> = {
  promise: "Promises to pay",
  installments: "Asks to pay in parts",
  paid_elsewhere: "Says they've paid",
  dispute: "Disputes the work",
  out_of_office: "Out of office",
  unclear: "Unclear",
};

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
