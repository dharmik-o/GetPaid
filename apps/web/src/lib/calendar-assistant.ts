import { getOwnTimeZone } from "./account";
import { routeTask } from "./ai-router";
import { calendarAnswerSchema, calendarProposalSchema, type CalendarProposal } from "./ai-schemas";
import { loadAiConnections, type AiConnection } from "./ai-settings";
import {
  createEntry,
  deleteEntry,
  getEntry,
  markEntryDone,
  parseEntryInput,
  updateEntry,
  type CalendarEntry,
} from "./calendar-entries";
import { calendarItems, type CalendarItem } from "./calendar-feed";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { moneyIn } from "./draft-checks";
import { askHelp, isHowToQuestion, type HelpAnswer } from "./help-assistant";
import { retrieveSections } from "./help-search";
import { unknownDates } from "./draft-dates";
import type { FieldIssue } from "./field-issues";
import { PROMPT_TEXT } from "./prompt-text";
import { safeText } from "./quoted-text";
import { addCalendarDays, todayIn } from "./schedule";

// Server-only: the calendar assistant. It answers from the freelancer's calendar and proposes changes
// to their own entries, and that is all it can do. The model only suggests: every answer is checked in
// code, a proposal happens only when the freelancer presses Apply, and Apply runs through the same
// validation as the entry form, as the signed-in user. Imported events, titles and the question are
// quoted data and can't give it instructions. Nothing the user asked or the model answered is logged.

export const UNAVAILABLE = "The assistant isn't available right now. Check Settings > AI.";
export const UNRELIABLE = "I couldn't answer that reliably. Try asking about a specific week.";
export const ONLY_OWN =
  "Only your own entries can be changed here; app dates and imported events open their own page.";

const DAYS_BEFORE = 14;
const DAYS_AFTER = 90;
const MAX_ITEMS = 300;
/** A proposal's dates must be within these limits of today. */
const PROPOSAL_DAYS_BEFORE = 30;
const PROPOSAL_DAYS_AFTER = 730;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export type HistoryTurn = { q: string; a: string };

type Context = {
  today: string;
  zone: string;
  now: Date;
  items: CalendarItem[];
  clientNames: string[];
};

// Building what the model sees -------------------------------------------------------------------

const clockIn = (iso: string, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(new Date(iso));

const whenOf = (item: CalendarItem, zone: string): string => {
  if (item.startAt === null) {
    return `${item.startsOn}${item.endsOn ? ` to ${item.endsOn}` : ""} all day`;
  }
  const end = item.endAt === null ? "" : `–${clockIn(item.endAt, zone)}`;
  return `${item.startsOn} ${clockIn(item.startAt, zone)}${end}`;
};

export const itemLine = (item: CalendarItem, zone: string): string =>
  `[${item.key}] ${item.type} | ${whenOf(item, zone)} | ${safeText(item.title)} | ${safeText(item.clientName ?? "none")} | ${item.status ?? "none"} | editable ${item.editable ? "yes" : "no"}`;

const weekdayOf = (isoDate: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );

/** The 300 items nearest to today, in date order. */
const nearest = (items: CalendarItem[], today: string): CalendarItem[] => {
  if (items.length <= MAX_ITEMS) return items;
  const distance = (item: CalendarItem): number =>
    Math.abs(Date.parse(`${item.startsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`));
  return [...items]
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, MAX_ITEMS)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.key.localeCompare(b.key));
};

const loadContext = async (db: Db, now: Date): Promise<Context> => {
  const zone = await getOwnTimeZone(db);
  const today = todayIn(now, zone);
  const items = nearest(
    await calendarItems(db, {
      from: addCalendarDays(today, -DAYS_BEFORE),
      to: addCalendarDays(today, DAYS_AFTER),
      zone,
    }),
    today,
  );
  const { rows } = await db.query<{ name: string }>("SELECT name FROM public.clients");
  return { today, zone, now, items, clientNames: rows.map((row) => row.name) };
};

const historyText = (history: HistoryTurn[]): string =>
  history.map((turn) => `Q: ${safeText(turn.q)}\nA: ${safeText(turn.a)}`).join("\n");

export const assistantMessages = (
  context: Context,
  history: HistoryTurn[],
  question: string,
): { role: "system" | "user"; content: string }[] => {
  const time = clockIn(context.now.toISOString(), context.zone);
  const lines = context.items.map((item) => itemLine(item, context.zone));
  return [
    { role: "system", content: PROMPT_TEXT.calendar_assistant },
    {
      role: "user",
      content: [
        "<calendar>",
        `Today: ${context.today}, ${weekdayOf(context.today)}, ${time}, time zone ${context.zone}`,
        "Items:",
        ...(lines.length > 0 ? lines : ["(no items)"]),
        "</calendar>",
        `<history>\n${historyText(history)}\n</history>`,
        `<question>${safeText(question)}</question>`,
      ].join("\n"),
    },
  ];
};

// Checking what the model said ---------------------------------------------------------------------

const clockProblem = (start: string | null, end: string | null): boolean =>
  (start !== null && !CLOCK.test(start)) ||
  (end !== null && !CLOCK.test(end)) ||
  (end !== null && start === null) ||
  (start !== null && end !== null && end <= start);

const outsideWindow = (date: string, today: string): boolean =>
  date < addCalendarDays(today, -PROPOSAL_DAYS_BEFORE) ||
  date > addCalendarDays(today, PROPOSAL_DAYS_AFTER);

/** What's wrong with a proposal's dates and times, or undefined. Applies to move and create. */
const proposalProblem = (proposal: CalendarProposal, today: string): string | undefined => {
  if (proposal.op !== "move" && proposal.op !== "create") return undefined;
  if (outsideWindow(proposal.startsOn, today)) return "that date is too far from today";
  return clockProblem(proposal.startTime, proposal.endTime)
    ? "the times need a start, and an end after it"
    : undefined;
};

const isOwnEntryKey = (key: string, items: CalendarItem[]): boolean =>
  items.some((item) => item.key === key && item.type === "entry" && item.editable);

const clientNamed = (name: string | null, clientNames: string[]): string | null =>
  name === null
    ? null
    : (clientNames.find((known) => known.toLowerCase() === name.trim().toLowerCase()) ?? null);

export type ProposalView = CalendarProposal & { title: string | null };
export type ReferenceView = { key: string; title: string; href: string };
export type CheckedAnswer = {
  answer: string;
  references: ReferenceView[];
  proposals: ProposalView[];
};

/** Every date the answer may mention: today, the items' dates, the proposals' dates. */
const knownDateTexts = (context: Context, proposals: CalendarProposal[]): string[] => [
  `${weekdayOf(context.today)} ${context.today}`,
  ...context.items.flatMap((item) =>
    [item.startsOn, item.endsOn].flatMap((date) => (date ? [`${weekdayOf(date)} ${date}`] : [])),
  ),
  ...proposals.flatMap((proposal) =>
    proposal.op === "move" || proposal.op === "create"
      ? [`${weekdayOf(proposal.startsOn)} ${proposal.startsOn}`]
      : [],
  ),
];

/**
 * The model's answer, checked in code. A date or an amount in the text that isn't in the calendar
 * replaces the answer and drops every proposal. Proposals that touch anything but the freelancer's
 * own entries are dropped (with a line saying where to change them), and so are ones with dates too
 * far away or times that don't make sense.
 */
export const checkAssistantAnswer = (
  raw: { answer: string; references: string[]; proposals: CalendarProposal[] },
  context: Context,
): CheckedAnswer => {
  const byKey = new Map(context.items.map((item) => [item.key, item]));
  const titles = [...context.items.map((item) => item.title), ...context.clientNames];
  const proposalTitles = raw.proposals.flatMap((p) => (p.op === "create" ? [p.title] : []));
  const strangeDate =
    unknownDates(raw.answer, {
      facts: knownDateTexts(context, raw.proposals),
      quoted: [...titles, ...proposalTitles],
    }).length > 0;
  const knownAmounts = new Set(
    moneyIn(context.items.map((item) => item.title).join("\n")).map((m) => m.amount),
  );
  const strangeAmount = moneyIn(raw.answer).some((money) => !knownAmounts.has(money.amount));
  if (strangeDate || strangeAmount) return { answer: UNRELIABLE, references: [], proposals: [] };

  let droppedForOwnership = false;
  const proposals: ProposalView[] = [];
  for (const proposal of raw.proposals) {
    if (proposal.op !== "create" && !isOwnEntryKey(proposal.key, context.items)) {
      droppedForOwnership = true;
      continue;
    }
    if (proposalProblem(proposal, context.today)) continue;
    const title =
      proposal.op === "create" ? proposal.title : (byKey.get(proposal.key)?.title ?? null);
    proposals.push({
      ...proposal,
      ...(proposal.op === "create"
        ? { clientName: clientNamed(proposal.clientName, context.clientNames) }
        : {}),
      title,
    } as ProposalView);
  }
  const references = [...new Set(raw.references)].flatMap((key): ReferenceView[] => {
    const item = byKey.get(key);
    return item ? [{ key, title: item.title, href: item.href }] : [];
  });
  return {
    answer: droppedForOwnership ? `${raw.answer} ${ONLY_OWN}` : raw.answer,
    references,
    proposals,
  };
};

// Asking ------------------------------------------------------------------------------------------

export type AssistantDeps = {
  runAsUser: UserDbRunner;
  box: () => SecretBox;
  now: () => Date;
  /** Replaceable in tests; the real one calls the user's model through the router. */
  route?: typeof routeTask;
};

/** `help` is set when the question was about using the app: the same answer the Help panel gives. */
export type AskResult =
  | ({ ok: true } & CheckedAnswer & { help?: Pick<HelpAnswer, "sources" | "links"> })
  | { ok: false; error: string };

/** The calendar task's models, or the draft task's when the user has no calendar rows yet. */
const connectionsFor = async (db: Db, box: SecretBox): Promise<AiConnection[]> => {
  const own = await loadAiConnections(db, "calendar", box);
  return own.length > 0 ? own : loadAiConnections(db, "draft", box);
};

export const askCalendar = async (
  deps: AssistantDeps,
  input: { question: string; history: HistoryTurn[] },
): Promise<AskResult> => {
  // A how-to question about the app goes to the help task: same manual, same schema, same checks.
  if (
    isHowToQuestion(input.question) &&
    retrieveSections(input.question, { limit: 1 }).length > 0
  ) {
    const help = await askHelp(deps, input.question);
    if (!help.ok) return { ok: false, error: help.error };
    return {
      ok: true,
      answer: help.answer,
      references: [],
      proposals: [],
      help: { sources: help.sources, links: help.links },
    };
  }
  const prepared = await deps.runAsUser(async (db) => ({
    context: await loadContext(db, deps.now()),
    connections: await connectionsFor(db, deps.box()),
  }));
  // The model call runs outside any transaction: a local model can take a minute.
  const result = await (deps.route ?? routeTask)(prepared.connections, {
    messages: assistantMessages(prepared.context, input.history, input.question),
    schema: calendarAnswerSchema,
  });
  if (!result.ok) return { ok: false, error: UNAVAILABLE };
  return { ok: true, ...checkAssistantAnswer(result.output, prepared.context) };
};

// Applying ------------------------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true; entry: CalendarEntry | null }
  | { ok: false; status: 400 | 404; errors: FieldIssue[] };

const KEY_PREFIX = "entry:";

const refuse = (field: string, message: string, status: 400 | 404 = 400): ApplyResult => ({
  ok: false,
  status,
  errors: [{ field, message }],
});

/** The entry a key names, only if it's the freelancer's own (RLS finds nobody else's). */
const ownEntry = async (db: Db, key: string): Promise<CalendarEntry | null> =>
  key.startsWith(KEY_PREFIX) ? getEntry(db, key.slice(KEY_PREFIX.length)) : null;

const toResult = (
  result: { ok: true; entry: CalendarEntry } | { ok: false; errors: FieldIssue[] } | null,
): ApplyResult =>
  result === null
    ? refuse("key", "That entry wasn't found. It may have been deleted.", 404)
    : result.ok
      ? { ok: true, entry: result.entry }
      : { ok: false, status: 400, errors: result.errors };

/**
 * Applies one proposal the freelancer pressed Apply on: checked again with the same rules, then done
 * through the same functions as the entry form (createEntry, updateEntry, markEntryDone,
 * deleteEntry), as the signed-in user. Only their own entries can be changed.
 */
export const applyProposal = async (db: Db, raw: unknown, now: Date): Promise<ApplyResult> => {
  const parsed = calendarProposalSchema.safeParse(raw);
  if (!parsed.success) return refuse("proposal", "isn't a valid proposal");
  const proposal = parsed.data;
  const zone = await getOwnTimeZone(db);
  const problem = proposalProblem(proposal, todayIn(now, zone));
  if (problem) return refuse("proposal", problem);

  if (proposal.op === "create") {
    const { rows } = await db.query<{ id: string; name: string }>(
      "SELECT id::text, name FROM public.clients",
    );
    const client = clientNamed(
      proposal.clientName,
      rows.map((row) => row.name),
    );
    const clientId = rows.find((row) => row.name === client)?.id ?? null;
    const input = parseEntryInput(
      {
        title: proposal.title,
        kind: proposal.kind,
        startsOn: proposal.startsOn,
        startTime: proposal.startTime,
        endTime: proposal.endTime,
        clientId,
      },
      zone,
    );
    if (!input.ok) return { ok: false, status: 400, errors: input.errors };
    return toResult(await createEntry(db, input.value, "assistant"));
  }

  const entry = await ownEntry(db, proposal.key);
  if (!entry)
    return refuse(
      "key",
      "That entry wasn't found. Only your own entries can be changed here.",
      404,
    );
  if (proposal.op === "mark_done")
    return toResult(
      await markEntryDone(db, entry.id).then((done) => done && { ok: true as const, entry: done }),
    );
  if (proposal.op === "delete") {
    await deleteEntry(db, entry.id);
    return { ok: true, entry: null };
  }
  // Moving a several-day entry keeps its length.
  const days =
    entry.endsOn === null
      ? 0
      : (Date.parse(entry.endsOn) - Date.parse(entry.startsOn)) / 86_400_000;
  return toResult(
    await updateEntry(db, entry.id, {
      startsOn: proposal.startsOn,
      startTime: proposal.startTime,
      endTime: proposal.endTime,
      endsOn:
        proposal.startTime === null && days > 0 ? addCalendarDays(proposal.startsOn, days) : null,
    }),
  );
};
