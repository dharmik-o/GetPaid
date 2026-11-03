import Mustache from "mustache";

// The tags an invoice template may use (docs/MVP-spec.md, Invoice templates), and the check
// that a template uses only those, only escaped. An unknown tag is an error, never a blank.
// Pure: safe in client components (the editor's tag list uses it too).

export type TagGroup = { group: string; tags: readonly string[] };

const EXPENSE_SHORTCUTS = Array.from({ length: 10 }, (_, i) => `expense_${String(i + 1)}`);

export const TAG_GROUPS: readonly TagGroup[] = [
  {
    group: "Freelancer",
    tags: [
      "freelancer.name",
      "freelancer.business_name",
      "freelancer.email",
      "freelancer.address",
      "freelancer.logo",
    ],
  },
  { group: "Client", tags: ["client.name", "client.company", "client.email", "client.address"] },
  {
    group: "Invoice",
    tags: [
      "invoice.number",
      "invoice.issue_date",
      "invoice.due_date",
      "invoice.title",
      "invoice.pay_link",
      "invoice.terms",
      "invoice.late_fee_clause",
    ],
  },
  { group: "Line item shortcuts", tags: EXPENSE_SHORTCUTS },
  {
    group: "Totals",
    tags: ["totals.subtotal", "totals.tax", "totals.discount", "totals.total", "currency"],
  },
  {
    group: "Installments",
    tags: [
      "installment.number",
      "installment.count",
      "installment.paid_so_far",
      "installment.remaining",
    ],
  },
  { group: "AI-written text", tags: ["greeting", "thank_you_note", "project_summary", "notes"] },
];

/** Repeating sections and the tags available inside each row. */
export const LIST_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  items: ["name", "description", "quantity", "unit_price", "amount"],
  "installment.schedule": ["number", "amount", "due_date", "status"],
};

const TOP_TAGS = new Set(TAG_GROUPS.flatMap((g) => g.tags));

/** Tags that may only appear as a whole attribute value: href and src. */
export const URL_TAGS: Readonly<Record<string, string>> = {
  href: "invoice.pay_link",
  src: "freelancer.logo",
};

export type TagIssue = { line: number; message: string };

type Token = [string, string, number, number, Token[]?, number?];

const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

const walk = (tokens: Token[], source: string, lists: string[], issues: TagIssue[]): void => {
  for (const [type, name, start, , children] of tokens) {
    const line = lineAt(source, start);
    const rowTags = lists.flatMap((list) => LIST_SECTIONS[list] ?? []);
    const known = TOP_TAGS.has(name) || rowTags.includes(name);
    switch (type) {
      case "text":
      case "!":
        break;
      case "name":
        if (!known) issues.push({ line, message: `{{${name}}} isn't a tag this app fills in` });
        break;
      case "&":
        issues.push({
          line,
          message: `{{{${name}}}} and {{& ${name}}} aren't allowed: every value is escaped`,
        });
        break;
      case ">":
        issues.push({ line, message: `{{> ${name}}} (a partial) isn't allowed` });
        break;
      case "#":
      case "^": {
        const isList = name in LIST_SECTIONS;
        if (!isList && !known) {
          issues.push({
            line,
            message: `{{${type}${name}}} isn't a list or a tag this app fills in`,
          });
        }
        walk(children ?? [], source, isList && type === "#" ? [...lists, name] : lists, issues);
        break;
      }
      default:
        issues.push({ line, message: `{{${type}${name}}} isn't allowed in a template` });
    }
  }
};

/** Every problem with a template's tags; empty when it's fine. */
export const checkTemplateTags = (html: string): TagIssue[] => {
  if (/\{\{\s*=/.test(html)) {
    return [
      {
        line: lineAt(html, html.search(/\{\{\s*=/)),
        message: "changing the {{ }} delimiters isn't allowed",
      },
    ];
  }
  let tokens: Token[];
  try {
    tokens = Mustache.parse(html) as Token[];
  } catch (error) {
    const message = error instanceof Error ? error.message : "it can't be read";
    return [
      {
        line: 1,
        message: `The tags don't parse: ${message}. Check that every {{#…}} has its {{/…}}.`,
      },
    ];
  }
  const issues: TagIssue[] = [];
  walk(tokens, html, [], issues);
  return issues;
};
