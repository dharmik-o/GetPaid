import sanitizeHtml from "sanitize-html";
import { sanitizeCss, sanitizeInlineStyle } from "./template-css";
import { checkTemplateTags, URL_TAGS, type TagIssue } from "./template-tags";

// Server-only: sanitises a custom template on save (custom HTML is untrusted input). Scripts,
// event handlers, iframes, objects, embeds, forms and javascript: links are removed; anything
// that would load from the network (a remote image, stylesheet or font) refuses the save, so
// the PDF is the same every time and a template can't send data anywhere.

export const TEMPLATE_MAX_BYTES = 100 * 1024;

export type SanitizeResult = {
  html: string;
  css: string;
  /** What was taken out; the editor shows these as notes. */
  removed: string[];
  /** Why the template can't be saved as it is. */
  refused: string[];
  tagIssues: TagIssue[];
  /** Safe to save: nothing refused and every tag known. */
  ok: boolean;
};

const ALLOWED_TAGS = [
  "div",
  "span",
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "img",
  "a",
  "header",
  "footer",
  "section",
  "article",
  "main",
  "aside",
  "address",
  "blockquote",
  "figure",
  "figcaption",
  "pre",
  "code",
];
const ALLOWED = new Set(ALLOWED_TAGS);

const COMMON_ATTRIBUTES = ["class", "id", "style", "title", "lang", "dir", "role", "aria-label"];

/** Tags whose content is dropped with them, not kept as text. */
const NON_TEXT_TAGS = [
  "script",
  "style",
  "textarea",
  "option",
  "noscript",
  "title",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "select",
  "button",
  "head",
];

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i;
const REMOTE = /^\s*(https?:)?\/\//i;

type Notes = { removed: string[]; refused: string[] };

const note = (list: string[], message: string): void => {
  if (!list.includes(message)) list.push(message);
};

/** Reports tags that will be dropped, and refuses the ones that load remote files. */
const onDisallowedTag = (name: string, attribs: Record<string, string>, notes: Notes): void => {
  if (ALLOWED.has(name)) return;
  const target = attribs.src ?? attribs.href ?? attribs.data ?? "";
  if (REMOTE.test(target)) {
    note(notes.refused, `<${name}> loads a remote file; nothing may load from the network`);
  } else {
    note(notes.removed, `the <${name}> element`);
  }
};

const checkHref = (value: string, notes: Notes): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === `{{${URL_TAGS.href ?? ""}}}`) return trimmed;
  if (/^(https:\/\/|mailto:|#)/i.test(trimmed) && !trimmed.includes("{{")) return trimmed;
  note(notes.removed, "a link that isn't https, mailto or {{invoice.pay_link}}");
  return undefined;
};

const checkSrc = (value: string, notes: Notes): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === `{{${URL_TAGS.src ?? ""}}}` || DATA_IMAGE.test(trimmed)) return trimmed;
  if (REMOTE.test(trimmed) || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    note(
      notes.refused,
      "a remote image: images must be embedded (use {{freelancer.logo}} for the logo)",
    );
  } else {
    note(notes.removed, "an image source that isn't embedded");
  }
  return undefined;
};

/** Checks every attribute of an allowed tag: handlers, URLs and inline styles. */
const cleanAttributes = (attribs: Record<string, string>, notes: Notes): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(attribs)) {
    if (name.startsWith("on")) {
      note(notes.removed, `the ${name} event handler`);
      continue;
    }
    if (/javascript:|vbscript:/i.test(value.replace(/\s+/g, ""))) {
      note(notes.removed, `a javascript: value in ${name}`);
      continue;
    }
    let clean: string | undefined = value;
    if (name === "href") clean = checkHref(value, notes);
    if (name === "src") clean = checkSrc(value, notes);
    if (name === "style") {
      const style = sanitizeInlineStyle(value);
      style.removed.forEach((m) => {
        note(notes.removed, m);
      });
      style.refused.forEach((m) => {
        note(notes.refused, m);
      });
      clean = style.css || undefined;
    }
    if (clean !== undefined) kept[name] = clean;
  }
  return kept;
};

const cleanHtml = (html: string, notes: Notes): string =>
  sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": COMMON_ATTRIBUTES,
      a: ["href"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      col: ["span"],
      colgroup: ["span"],
    },
    allowedSchemes: ["https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    nonTextTags: NON_TEXT_TAGS,
    disallowedTagsMode: "discard",
    onOpenTag: (name, attribs) => {
      onDisallowedTag(name, attribs, notes);
    },
    transformTags: {
      "*": (tagName, attribs) => ({
        tagName,
        attribs: ALLOWED.has(tagName) ? cleanAttributes(attribs, notes) : attribs,
      }),
    },
  });

const dedupeIssues = (issues: TagIssue[]): TagIssue[] =>
  issues.filter((issue, i) => issues.findIndex((o) => o.message === issue.message) === i);

export const sanitizeTemplate = ({ html, css }: { html: string; css: string }): SanitizeResult => {
  const size = Buffer.byteLength(html, "utf8") + Buffer.byteLength(css, "utf8");
  if (size > TEMPLATE_MAX_BYTES) {
    const kb = Math.ceil(size / 1024);
    return {
      html,
      css,
      removed: [],
      refused: [`HTML and CSS together are ${String(kb)} KB; the limit is 100 KB`],
      tagIssues: [],
      ok: false,
    };
  }
  const notes: Notes = { removed: [], refused: [] };
  const cleanedCss = sanitizeCss(css);
  cleanedCss.removed.forEach((m) => {
    note(notes.removed, m);
  });
  cleanedCss.refused.forEach((m) => {
    note(notes.refused, m);
  });
  const cleaned = cleanHtml(html, notes).trim();
  const tagIssues = dedupeIssues([...checkTemplateTags(html), ...checkTemplateTags(cleaned)]);
  return {
    html: cleaned,
    css: cleanedCss.css,
    removed: notes.removed,
    refused: notes.refused,
    tagIssues,
    ok: notes.refused.length === 0 && tagIssues.length === 0,
  };
};
