import { classificationSchema, type Classification } from "./ai-schemas";
import { routeTask } from "./ai-router";
import type { AiConnection } from "./ai-settings";
import { PROMPT_TEXT } from "./prompt-text";

// Server-only: asks the AI router to sort a client's reply. The reply is untrusted and goes in as
// quoted data. The answer must match the schema, and it's only ever a suggestion: nothing here can
// change anything. With no good answer, it's "unclear", so a person looks at it.

export type ReplyFacts = { today: string; dueDate: string; amountDue: string };

const FOR_MODEL_MAX = 4000;

/** "<" becomes the JSON escape u003c, so text in the reply can't close its tag. */
const quoted = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, `${String.fromCharCode(92)}u003c`);

const NOTHING_TO_SORT: Classification = {
  label: "unclear",
  promisedDate: null,
  returnDate: null,
  summary: "The AI couldn't sort this reply. Read it and decide what to do.",
};

/** The client's new words: without quoted earlier mail, which the model shouldn't sort. */
export const replyForModel = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((line) => /^On .+ wrote:\s*$/.test(line.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim()
    .slice(0, FOR_MODEL_MAX);
};

export const classifyReply = async (
  connections: AiConnection[],
  text: string,
  facts: ReplyFacts,
): Promise<Classification> => {
  const result = await routeTask(connections, {
    messages: [
      { role: "system", content: PROMPT_TEXT.classify_reply },
      {
        role: "user",
        content: `<facts>${quoted(facts)}</facts>\n<reply>${quoted(replyForModel(text))}</reply>`,
      },
    ],
    schema: classificationSchema,
    template: NOTHING_TO_SORT,
  });
  return result.ok ? result.output : NOTHING_TO_SORT;
};
