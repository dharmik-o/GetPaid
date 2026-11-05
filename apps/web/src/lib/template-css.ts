import postcss, { type Declaration, type Root } from "postcss";

// Server-only: the CSS half of the template sanitiser. Keeps a known set of properties and
// the @media and @page rules; drops everything else. Anything that would load from the network
// (a remote url(), @import) is refused, not dropped, so the freelancer sees why.

export type CssResult = { css: string; removed: string[]; refused: string[] };

const PROPERTY_PREFIXES = [
  "background-color",
  "background-image",
  "border",
  "margin",
  "padding",
  "font",
  "text-",
  "list-style",
  "flex",
  "grid",
  "page-break-",
  "break-",
  "outline",
] as const;

const PROPERTIES = new Set([
  "color",
  "background",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "vertical-align",
  "white-space",
  "word-break",
  "overflow-wrap",
  "display",
  "float",
  "clear",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "opacity",
  "box-sizing",
  "box-shadow",
  "border-collapse",
  "border-spacing",
  "table-layout",
  "caption-side",
  "empty-cells",
  "justify-content",
  "align-items",
  "align-self",
  "align-content",
  "gap",
  "row-gap",
  "column-gap",
  "orphans",
  "widows",
  "size",
  "overflow",
  "writing-mode",
  "transform",
  "transform-origin",
]);

const AT_RULES = new Set(["media", "page"]);

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i;

const allowedProperty = (prop: string): boolean => {
  const name = prop.toLowerCase();
  return PROPERTIES.has(name) || PROPERTY_PREFIXES.some((prefix) => name.startsWith(prefix));
};

/** Each url() in a value: "data" (an embedded image), "remote" or "other". */
const urlsIn = (value: string): ("data" | "remote" | "other")[] =>
  [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(([, , target = ""]) => {
    if (DATA_IMAGE.test(target)) return "data";
    if (/^(https?:)?\/\//i.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return "remote";
    return "other";
  });

/** Checks one declaration in place: removes it, or notes a refusal. */
const checkDeclaration = (decl: Declaration, result: CssResult): void => {
  const where = `"${decl.prop}"`;
  if (!allowedProperty(decl.prop)) {
    result.removed.push(`the CSS property ${where}`);
    decl.remove();
    return;
  }
  // Escapes and expression() can hide a url or script from the checks above.
  if (/\\|expression\s*\(|javascript:/i.test(decl.value)) {
    result.removed.push(`the value of ${where} (escapes and expressions aren't allowed)`);
    decl.remove();
    return;
  }
  const urls = urlsIn(decl.value);
  if (urls.includes("remote")) {
    result.refused.push(`${where} loads a remote file; embed images in the template instead`);
  } else if (urls.includes("other")) {
    result.removed.push(`a url() in ${where} that isn't an embedded image`);
    decl.remove();
  }
};

const walk = (root: Root, result: CssResult): void => {
  root.walkComments((comment) => {
    comment.remove();
  });
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (AT_RULES.has(name)) return;
    if (name === "import") {
      result.refused.push("@import loads a remote stylesheet; put the CSS in the template");
    } else {
      result.removed.push(`the @${name} rule`);
    }
    rule.remove();
  });
  root.walkDecls((decl) => {
    checkDeclaration(decl, result);
  });
};

export const sanitizeCss = (css: string): CssResult => {
  const result: CssResult = { css: "", removed: [], refused: [] };
  if (css.includes("{{")) result.refused.push("tags can't go in the CSS; put them in the HTML");
  // "<" could close the <style> block the CSS is placed in.
  if (css.includes("<")) result.refused.push('the CSS has a "<", which isn\'t allowed');
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    const reason =
      error instanceof Error && "reason" in error ? String(error.reason) : "unreadable";
    result.refused.push(`the CSS can't be read (${reason})`);
    return result;
  }
  walk(root, result);
  result.css = root.toString().trim();
  return result;
};

/** An inline style="" attribute: the same checks, on a single rule. */
export const sanitizeInlineStyle = (style: string): CssResult => {
  const result: CssResult = { css: "", removed: [], refused: [] };
  let root: Root;
  try {
    root = postcss.parse(`x{${style}}`);
  } catch {
    result.removed.push("an inline style that can't be read");
    return result;
  }
  const [rule, ...rest] = root.nodes;
  if (!rule || rule.type !== "rule" || rest.length > 0 || style.includes("}")) {
    result.removed.push("an inline style that can't be read");
    return result;
  }
  walk(root, result);
  result.css = rule.nodes
    .filter((node): node is Declaration => node.type === "decl")
    .map((decl) => `${decl.prop}: ${decl.value}${decl.important ? " !important" : ""}`)
    .join("; ");
  return result;
};
