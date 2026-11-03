// Server-only event log: one JSON line per event on stderr. Pass ids and short codes only;
// never secrets, tokens, email bodies or request bodies.

type LogFields = Record<string, string | number | boolean | null>;

export const logEvent = (event: string, fields: LogFields = {}): void => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};

/** The error's class name only: messages can hold user data. */
export const errorKind = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;
