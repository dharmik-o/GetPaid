// Finds every date in a draft, in any common format, and says which aren't in the facts. The same
// date in another format is fine: "May 15, 2027" for "15 May 2027". Relative dates ("next Friday")
// can't be in the facts, so they count as new unless a fact or the freelancer's note says them.
// Pure: safe in client components.

type DateParts = { year?: number; month?: number; day?: number; weekday?: number };

type Found = {
  raw: string;
  index: number;
  /** One reading, or two for 05/06/2027. Any reading in the facts is enough. */
  readings: DateParts[];
  /** Set for "next Friday": compared as words. */
  relative?: string;
  /** Set for "within 14 days". */
  spanDays?: number;
};

const MONTHS: readonly (readonly [string, number])[] = [
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sept", 9],
  ["sep", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
];
const MONTH_NUMBERS = new Map(MONTHS);
const MONTH = `(${MONTHS.map(([name]) => name).join("|")})\\.?`;

const WEEKDAYS: readonly (readonly [string, number])[] = [
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tues", 2],
  ["tue", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thurs", 4],
  ["thur", 4],
  ["thu", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6],
  ["sunday", 7],
  ["sun", 7],
];
const WEEKDAY_NUMBERS = new Map(WEEKDAYS);
const WEEKDAY_PREFIX = `(?:(${WEEKDAYS.map(([name]) => name).join("|")})\\.?,?\\s+)?`;
const FULL_WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

const ORDINAL_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "twenty-first",
  "twenty-second",
  "twenty-third",
  "twenty-fourth",
  "twenty-fifth",
  "twenty-sixth",
  "twenty-seventh",
  "twenty-eighth",
  "twenty-ninth",
  "thirtieth",
  "thirty-first",
];
// Longest first, so "twenty-first" isn't read as "first".
const ORDINAL = `(${[...ORDINAL_WORDS].sort((a, b) => b.length - a.length).join("|")})`;

const DAY = "(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])";
const YEAR_AFTER = "(?:,?[\\s-]+(\\d{4})(?!\\d))?";
const COUNT = "(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of)";
const NUMBER_WORDS = new Map([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

const numberOf = (text: string | undefined): number | undefined =>
  text === undefined ? undefined : Number(text);

const fullYear = (text: string): number => {
  const value = Number(text);
  return text.length === 2 ? 2000 + value : value;
};

/** "may" in lower case is nearly always the verb. */
const monthOf = (text: string | undefined): number | undefined => {
  if (text === undefined || text === "may") return undefined;
  return MONTH_NUMBERS.get(text.toLowerCase());
};

const weekdayOf = (text: string | undefined): number | undefined =>
  text === undefined ? undefined : WEEKDAY_NUMBERS.get(text.toLowerCase());

const withWeekday = (parts: DateParts, weekday: string | undefined): DateParts => {
  const number = weekdayOf(weekday);
  return number === undefined ? parts : { ...parts, weekday: number };
};

/** Numbers that could be a day and month, in whichever order is possible. */
const numericReadings = (first: number, second: number, year?: number): DateParts[] => {
  const readings: DateParts[] = [];
  const add = (day: number, month: number) => {
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      readings.push({ day, month, ...(year === undefined ? {} : { year }) });
    }
  };
  add(first, second);
  if (first !== second) add(second, first);
  return readings;
};

type Rule = {
  pattern: RegExp;
  read: (
    groups: (string | undefined)[],
  ) => Pick<Found, "readings" | "relative" | "spanDays"> | undefined;
};

const dates = (...readings: DateParts[]) => (readings.length > 0 ? { readings } : undefined);

const dayMonth = (
  weekday: string | undefined,
  day: number | undefined,
  monthText: string | undefined,
  year: string | undefined,
) => {
  const month = monthOf(monthText);
  if (month === undefined || day === undefined) return undefined;
  return dates(
    withWeekday({ day, month, ...(year === undefined ? {} : { year: Number(year) }) }, weekday),
  );
};

const ordinalDay = (word: string | undefined): number | undefined => {
  const index = word === undefined ? -1 : ORDINAL_WORDS.indexOf(word.toLowerCase());
  return index < 0 ? undefined : index + 1;
};

const spanOf = (count: string | undefined, unit: string | undefined): number | undefined => {
  if (count === undefined || unit === undefined) return undefined;
  const number = NUMBER_WORDS.get(count.toLowerCase()) ?? Number(count);
  if (Number.isNaN(number)) return undefined;
  return unit.toLowerCase().startsWith("day") ? number : undefined;
};

/** Most specific first: each match is blanked out, so nothing is read twice. */
const RULES: readonly Rule[] = [
  // 2027-05-15, 2027/05/15
  {
    pattern: /(?<![\w./-])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)(?:T[\d:.]+Z?)?/g,
    read: ([year, , month, day]) =>
      dates({ year: Number(year), month: numberOf(month) ?? 0, day: numberOf(day) ?? 0 }),
  },
  // 15/05/2027, 05/15/2027, 15.05.27, 15-05-2027
  {
    pattern: /(?<![\w./-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\w/-]|\.\d)/g,
    read: ([first, , second, year]) =>
      dates(...numericReadings(Number(first), Number(second), fullYear(year ?? ""))),
  },
  // Saturday, 15th of May, 2027 / the 15 May
  {
    pattern: new RegExp(
      `\\b${WEEKDAY_PREFIX}(?:the\\s+)?${DAY}(?:\\s+of)?[\\s-]+${MONTH}${YEAR_AFTER}`,
      "gi",
    ),
    read: ([weekday, day, month, year]) => dayMonth(weekday, numberOf(day), month, year),
  },
  // Saturday, May 15th, 2027 / May the 15th
  {
    pattern: new RegExp(`\\b${WEEKDAY_PREFIX}${MONTH}\\s+(?:the\\s+)?${DAY}${YEAR_AFTER}`, "gi"),
    read: ([weekday, month, day, year]) => dayMonth(weekday, numberOf(day), month, year),
  },
  // the fifteenth of May, 2027
  {
    pattern: new RegExp(`\\b(?:the\\s+)?${ORDINAL}\\s+of\\s+${MONTH}${YEAR_AFTER}`, "gi"),
    read: ([word, month, year]) => dayMonth(undefined, ordinalDay(word), month, year),
  },
  // May 2027, May of 2027
  {
    pattern: new RegExp(`\\b${MONTH}\\s+(?:of\\s+)?(\\d{4})(?!\\d)`, "gi"),
    read: ([monthText, year]) => {
      const month = monthOf(monthText);
      return month === undefined ? undefined : dates({ month, year: Number(year) });
    },
  },
  // Relative words, before weekdays alone, so "next Friday" is one mention.
  {
    pattern: new RegExp(
      `\\b(today|tomorrow|tonight|yesterday|(?:next|last|this)\\s+(?:week|month|year|${FULL_WEEKDAY})|(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:day|week|month|year))\\b`,
      "gi",
    ),
    read: ([words]) => ({
      readings: [],
      relative: (words ?? "").toLowerCase().replace(/\s+/g, " "),
    }),
  },
  // in 3 days, within a week
  {
    pattern: new RegExp(
      `\\b(?:in|within)\\s+${COUNT}\\s+(?:business\\s+|working\\s+)?(days?|weeks?|months?)\\b`,
      "gi",
    ),
    read: ([count, unit]) => {
      const spanDays = spanOf(count, unit);
      return {
        readings: [],
        relative: `${count ?? ""} ${unit ?? ""}`.toLowerCase(),
        ...(spanDays === undefined ? {} : { spanDays }),
      };
    },
  },
  // 5 days from now, 3 days ago
  {
    pattern: new RegExp(`\\b${COUNT}\\s+(days?|weeks?|months?)\\s+(from\\s+now|ago)\\b`, "gi"),
    read: ([count, unit]) => ({
      readings: [],
      relative: `${count ?? ""} ${unit ?? ""}`.toLowerCase(),
    }),
  },
  // by May, end of June. Capitals only: "in march" is rarely a date, and "by may" never.
  {
    pattern: new RegExp(
      `\\b(?:[Ii]n|[Bb]y|[Uu]ntil|[Bb]efore|[Aa]fter|[Dd]uring|[Ss]ince|[Ff]rom|[Tt]ill|[Ee]nd of|[Ss]tart of|[Bb]eginning of|[Ee]arly|[Mm]id|[Ll]ate)[\\s-]+(${MONTHS.map(([name]) => `${(name[0] ?? "").toUpperCase()}${name.slice(1)}`).join("|")})\\b\\.?`,
      "g",
    ),
    read: ([monthText]) => {
      const month = monthOf(monthText);
      return month === undefined ? undefined : dates({ month });
    },
  },
  // on the 15th, by 15th; "the 15th" at the end of a sentence. Not "the 2nd reminder".
  {
    pattern:
      /\b(?:on|by|until|till|before|after|from|since)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi,
    read: ([day]) => dates({ day: Number(day) }),
  },
  {
    pattern: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?=\s*(?:[.,;:!?)]|$))/gi,
    read: ([day]) => dates({ day: Number(day) }),
  },
  // 15/05, but not 24/7
  {
    pattern: /(?<![\w./-])(\d{1,2})\/(\d{1,2})(?![\w/-]|\.\d)/g,
    read: ([first, second]) =>
      first === "24" && second === "7"
        ? undefined
        : dates(...numericReadings(Number(first), Number(second))),
  },
  // Friday, on its own
  {
    pattern: new RegExp(`\\b(${FULL_WEEKDAY})\\b`, "gi"),
    read: ([weekday]) => {
      const number = weekdayOf(weekday);
      return number === undefined ? undefined : dates({ weekday: number });
    },
  },
];

const blank = (text: string, start: number, length: number): string =>
  `${text.slice(0, start)}${" ".repeat(length)}${text.slice(start + length)}`;

const scan = (input: string): Found[] => {
  let text = input.replace(URL_PATTERN, (url) => " ".repeat(url.length));
  const found: Found[] = [];
  for (const { pattern, read } of RULES) {
    for (const match of text.matchAll(pattern)) {
      const result = read(match.slice(1));
      if (!result) continue;
      found.push({ raw: match[0].trim().replace(/[.,]$/, ""), index: match.index, ...result });
      text = blank(text, match.index, match[0].length);
    }
  }
  return found.sort((a, b) => a.index - b.index);
};

const weekdayOfDate = ({ year, month, day }: DateParts): number | undefined => {
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

/** A day or month in the draft must be in the fact. A year may only differ if the fact has none. */
const sameDate = (reading: DateParts, fact: DateParts): boolean => {
  if (reading.day === undefined && reading.month === undefined && reading.year === undefined) {
    return reading.weekday !== undefined && weekdayOfDate(fact) === reading.weekday;
  }
  if (reading.day !== undefined && reading.day !== fact.day) return false;
  if (reading.month !== undefined && reading.month !== fact.month) return false;
  if (reading.year !== undefined && fact.year !== undefined && reading.year !== fact.year) {
    return false;
  }
  if (reading.weekday === undefined) return true;
  const full = { ...fact, ...reading };
  return weekdayOfDate(full) === reading.weekday;
};

const NET_TERMS = /\bNet\s+(\d+)\b/gi;

export type DateFacts = {
  /** Every fact a date may come from. */
  facts: readonly string[];
  /** Names the draft may quote word for word, even if they look like dates. */
  quoted?: readonly string[];
  /** What the freelancer wrote or already saw: their own words can name a date. */
  alsoAllowed?: readonly string[];
};

/** Each date in the text that the facts don't hold, as written, in order. */
export const unknownDates = (
  text: string,
  { facts, quoted = [], alsoAllowed = [] }: DateFacts,
): string[] => {
  const sources = [...facts, ...alsoAllowed];
  const known = sources.flatMap(scan);
  const knownDates = known.flatMap((item) => item.readings);
  const knownWords = new Set(known.flatMap((item) => (item.relative ? [item.relative] : [])));
  const agreedDays = new Set(
    facts.flatMap((fact) => [...fact.matchAll(NET_TERMS)].map(([, days]) => Number(days))),
  );
  const withoutNames = [...quoted]
    .filter((name) => name !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((rest, name) => rest.split(name).join(" ".repeat(name.length)), text);
  return scan(withoutNames)
    .filter((item) => {
      if (item.relative !== undefined) {
        const agreed = item.spanDays !== undefined && agreedDays.has(item.spanDays);
        return !agreed && !knownWords.has(item.relative);
      }
      return !item.readings.some((reading) => knownDates.some((fact) => sameDate(reading, fact)));
    })
    .map((item) => item.raw);
};
