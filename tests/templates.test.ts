import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceView, SAMPLE_DOCUMENT, type InvoiceDocument } from "@/lib/invoice-document";
import { renderInvoiceHtml, TemplateTagError } from "@/lib/template-render";
import { sanitizeTemplate, TEMPLATE_MAX_BYTES } from "@/lib/template-sanitize";
import { checkTemplateTags, LIST_SECTIONS, TAG_GROUPS } from "@/lib/template-tags";
import { openMigratedPglite, type TestDatabase } from "./db/pglite";

// Invoice templates: tags, escaping, the sanitiser and the three built-ins.

const LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  ...SAMPLE_DOCUMENT,
  freelancer: { ...SAMPLE_DOCUMENT.freelancer, logoDataUrl: LOGO },
  ...overrides,
});

const render = (html: string, document = doc()) =>
  renderInvoiceHtml({ html, css: "" }, invoiceView(document));

const TOP_TAGS = TAG_GROUPS.flatMap((g) => g.tags);

/** A template that uses every tag the app fills in, each in its own element. */
const EVERY_TAG = [
  ...TOP_TAGS.map((tag) => `<p data-tag="${tag}">{{${tag}}}</p>`),
  ...Object.entries(LIST_SECTIONS).map(
    ([list, tags]) =>
      `{{#${list}}}<div>${tags.map((t) => `<span>{{${t}}}</span>`).join("")}</div>{{/${list}}}`,
  ),
].join("\n");

describe("tags", () => {
  it("every tag fills, with no tag left over", () => {
    expect(checkTemplateTags(EVERY_TAG)).toEqual([]);
    const html = render(EVERY_TAG);
    expect(html).not.toContain("{{");
    expect(html).toContain("Rivera Studio");
    expect(html).toContain("FPR-000042");
    expect(html).toContain("3 Nov 2026");
    expect(html).toContain("17 Nov 2026");
    expect(html).toContain("Hello Sam,");
    // Mustache escapes "/" as &#x2F; inside the data URL; the browser decodes it.
    expect(html).toContain("iVBORw0KGgoAAAANSUhEUg");
    expect(html).toContain("Build: USD");
    expect(html).toContain("this invoice");
    expect(html).toContain("#INV2-SAMP-LE00-0000");
  });

  it("an unknown tag is an error with its line, never a blank", () => {
    const issues = checkTemplateTags("<p>{{client.name}}</p>\n<p>{{client.phone}}</p>");
    expect(issues).toEqual([
      { line: 2, message: "{{client.phone}} isn't a tag this app fills in" },
    ]);
    expect(() => render("<p>{{client.phone}}</p>")).toThrow(TemplateTagError);
  });

  it("row tags only work inside their list", () => {
    expect(checkTemplateTags("{{#items}}{{unit_price}}{{/items}}")).toEqual([]);
    expect(checkTemplateTags("<p>{{unit_price}}</p>")).toHaveLength(1);
    expect(checkTemplateTags("{{#items}}{{due_date}}{{/items}}")).toHaveLength(1);
  });

  it.each([
    ["an unescaped {{{tag}}}", "{{{greeting}}}"],
    ["an unescaped {{& tag}}", "{{& greeting}}"],
    ["a partial", "{{> header}}"],
    ["a delimiter change", "{{=<% %>=}}<% greeting %>"],
    ["an unknown section", "{{#lines}}x{{/lines}}"],
    ["an unclosed section", "{{#items}}x"],
  ])("refuses %s", (_label, html) => {
    expect(checkTemplateTags(html).length).toBeGreaterThan(0);
  });

  it("HTML-escapes every value", () => {
    const evil = doc({
      client: {
        ...SAMPLE_DOCUMENT.client,
        name: `<script>alert(1)</script>"><img src=x onerror=alert(1)>`,
      },
    });
    const html = render(`<p title="{{client.name}}">{{client.name}}</p>`, evil);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;&gt;");
  });

  it("wraps the document in a policy that loads nothing from the network", () => {
    const html = render("<p>{{greeting}}</p>");
    expect(html).toContain("default-src 'none'; img-src data:");
  });
});

describe("sanitizeTemplate", () => {
  const clean = (html: string, css = "") => sanitizeTemplate({ html, css });

  it("removes scripts, with their content", () => {
    const result = clean("<p>Hi</p><script>fetch('https://x.example')</script>");
    expect(result.html).toBe("<p>Hi</p>");
    expect(result.removed).toContain("the <script> element");
    expect(result.ok).toBe(true);
  });

  it.each(["onclick", "onerror", "onload", "ONMOUSEOVER"])(
    "removes the %s event handler",
    (attr) => {
      const result = clean(`<p ${attr}="alert(1)">Hi</p>`);
      expect(result.html).toBe("<p>Hi</p>");
      expect(result.removed).toContain(`the ${attr.toLowerCase()} event handler`);
    },
  );

  it.each(["iframe", "object", "embed", "form", "input", "style", "link", "svg", "base", "meta"])(
    "removes <%s>",
    (tag) => {
      const result = clean(`<div>ok</div><${tag}>x</${tag}>`);
      expect(result.html).not.toContain(`<${tag}`);
    },
  );

  it("removes javascript: links and links that aren't https, mailto or the pay link", () => {
    const result = clean(
      `<a href="javascript:alert(1)">a</a><a href="http://x.example">b</a><a href="{{client.name}}">c</a>`,
    );
    expect(result.html).toBe("<a>a</a><a>b</a><a>c</a>");
    const kept = clean(
      `<a href="{{invoice.pay_link}}">Pay</a><a href="mailto:a@example.test">m</a>`,
    );
    expect(kept.html).toBe(
      `<a href="{{invoice.pay_link}}">Pay</a><a href="mailto:a@example.test">m</a>`,
    );
  });

  it("refuses a template with a remote image", () => {
    for (const src of [
      "https://tracker.example/p.png",
      "http://x.example/a.png",
      "//x.example/a.png",
    ]) {
      const result = clean(`<img src="${src}">`);
      expect(result.ok).toBe(false);
      expect(result.refused[0]).toMatch(/remote image/);
    }
  });

  it("keeps embedded images and the logo tag", () => {
    const result = clean(`<img src="${LOGO}" alt="x"><img src="{{freelancer.logo}}">`);
    expect(result.ok).toBe(true);
    expect(result.html).toContain(`src="${LOGO}"`);
    expect(result.html).toContain(`src="{{freelancer.logo}}"`);
  });

  it("refuses remote resources in CSS and @import, and drops unknown properties", () => {
    expect(clean("<p>x</p>", "@import url(https://x.example/a.css);").refused[0]).toMatch(
      /@import/,
    );
    expect(clean("<p>x</p>", "p { background: url(https://x.example/t.png); }").ok).toBe(false);
    expect(
      clean("<p>x</p>", "@font-face { src: url(https://x.example/f.woff); }").removed,
    ).toContain("the @font-face rule");
    const css = clean("<p>x</p>", "p { color: red; behavior: url(x.htc); -moz-binding: x; }");
    expect(css.css).toBe("p { color: red; }");
    expect(css.removed).toContain('the CSS property "behavior"');
  });

  it("refuses tags or a '<' in the CSS", () => {
    expect(clean("<p>x</p>", "p { color: {{client.name}}; }").ok).toBe(false);
    expect(clean("<p>x</p>", "p { color: red; } </style><script>").ok).toBe(false);
  });

  it("checks inline styles the same way", () => {
    const result = clean(
      `<p style="color: red; background-image: url(https://x.example/t.png)">x</p>`,
    );
    expect(result.ok).toBe(false);
    const ok = clean(`<p style="color: red; position: fixed; behavior: url(x.htc)">x</p>`);
    expect(clean(`<p style="color: red; expression(alert(1))">x</p>`).html).toBe("<p>x</p>");
    expect(ok.html).toBe(`<p style="color:red;position:fixed">x</p>`);
  });

  it("refuses HTML plus CSS over 100 KB", () => {
    const big = clean("<p>x</p>", `p{color:red}${" ".repeat(TEMPLATE_MAX_BYTES)}`);
    expect(big.ok).toBe(false);
    expect(big.refused[0]).toMatch(/limit is 100 KB/);
  });

  it("reports unknown tags", () => {
    const result = clean("<p>{{client.phone}}</p>");
    expect(result.ok).toBe(false);
    expect(result.tagIssues[0]?.message).toMatch(/client\.phone/);
  });
});

describe("the built-in templates", () => {
  let handle: TestDatabase;
  let builtins: { name: string; html: string; css: string }[];

  beforeAll(async () => {
    handle = await openMigratedPglite();
    builtins = (
      await handle.db.query<{ name: string; html: string; css: string }>(
        "SELECT name, html, css FROM public.invoice_templates WHERE kind = 'builtin' ORDER BY id",
      )
    ).rows;
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it("are Classic, Modern and Minimal", () => {
    expect(builtins.map((b) => b.name)).toEqual(["Classic", "Modern", "Minimal"]);
  });

  it("pass the sanitiser unchanged in meaning: nothing removed or refused", () => {
    for (const builtin of builtins) {
      const result = sanitizeTemplate(builtin);
      expect({
        name: builtin.name,
        removed: result.removed,
        refused: result.refused,
        tags: result.tagIssues,
      }).toEqual({ name: builtin.name, removed: [], refused: [], tags: [] });
    }
  });

  it("show the name, client, totals, installment line, terms and pay link", () => {
    for (const builtin of builtins) {
      const html = renderInvoiceHtml(builtin, invoiceView(doc()));
      for (const text of [
        "Rivera Studio",
        "Sam Lee",
        "FPR-000042",
        "Net 14",
        "Installment 2 of 2",
        "#INV2-SAMP-LE00-0000",
        "Hello Sam,",
      ]) {
        expect({ name: builtin.name, has: html.includes(text), text }).toEqual({
          name: builtin.name,
          has: true,
          text,
        });
      }
    }
  });

  it("hide the installment block on a plain invoice", () => {
    for (const builtin of builtins) {
      const plain = doc({
        installment: null,
        items: [
          { name: "Build", description: "Website redesign: Build", quantity: 1, unitCents: 150000 },
        ],
      });
      const html = renderInvoiceHtml(builtin, invoiceView(plain));
      expect(html).not.toContain("Installment 2 of");
    }
  });
});
