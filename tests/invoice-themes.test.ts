import Mustache from "mustache";
import { beforeAll, describe, expect, it } from "vitest";
import { documentFontCss, DOCUMENT_FONT_FAMILIES } from "@/lib/document-fonts";
import { invoiceView, SAMPLE_DOCUMENT, type InvoiceDocument } from "@/lib/invoice-document";
import { BUILTIN_TEMPLATE_NOTES } from "@/lib/invoice-template-notes";
import { renderPdf, type PaperSize } from "@/lib/invoice-pdf";
import { payQrDataUrl } from "@/lib/pay-qr";
import { renderInvoiceHtml } from "@/lib/template-render";
import { sanitizeTemplate } from "@/lib/template-sanitize";
import { checkTemplateTags, LIST_SECTIONS, TAG_GROUPS } from "@/lib/template-tags";
import { openMigratedPglite } from "./db/pglite";

// The six built-ins: every tag, the sanitiser, self-hosted fonts, no bank details, and one page in
// both paper sizes with 12 line items. The PDF checks use real headless Chromium, offline.

type Builtin = { id: string; name: string; html: string; css: string };

const NAMES = ["Classic", "Modern", "Minimal", "Studio", "Ledger", "Noir"];
const PAPERS: PaperSize[] = ["A4", "Letter"];

let builtins: Builtin[] = [];

beforeAll(async () => {
  const handle = await openMigratedPglite();
  const { rows } = await handle.db.query<Builtin>(
    "SELECT id::text, name, html, css FROM public.invoice_templates WHERE kind = 'builtin' ORDER BY id",
  );
  builtins = rows;
  await handle.close();
}, 60_000);

const builtin = (name: string): Builtin => {
  const found = builtins.find((template) => template.name === name);
  if (!found) throw new Error(`The ${name} built-in is missing.`);
  return found;
};

type Token = [string, string, number, number, Token[]?];

const tagsIn = (tokens: Token[]): string[] =>
  tokens.flatMap(([type, name, , , children]) => [
    ...(type === "text" ? [] : [name]),
    ...tagsIn(children ?? []),
  ]);

/** Every tag a theme has to use. The expense shortcuts are for custom templates, not themes. */
const REQUIRED = [
  ...TAG_GROUPS.flatMap((group) => group.tags).filter((tag) => !tag.startsWith("expense_")),
  ...Object.entries(LIST_SECTIONS).flatMap(([section, rows]) => [section, ...rows]),
];

const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  name: `Line item ${String(i + 1)}`,
  description: "A description of the work that fills most of a line in the items table",
  quantity: 2,
  unitCents: 12_500,
}));

const twelveInstallments = Array.from({ length: 12 }, (_, i) => ({
  number: i + 1,
  amountCents: 12_500,
  dueDate: "2026-11-17",
  status: i === 0 ? ("this invoice" as const) : ("due" as const),
}));

const LONGEST: Record<string, InvoiceDocument> = {
  "12 line items": { ...SAMPLE_DOCUMENT, items: ITEMS, installment: null },
  "12 line items and an installment plan": {
    ...SAMPLE_DOCUMENT,
    items: ITEMS,
    taxCents: 1000,
    discountCents: 500,
  },
  "12 installments": {
    ...SAMPLE_DOCUMENT,
    installment: {
      number: 1,
      count: 12,
      paidSoFarCents: 0,
      remainingCents: 137_500,
      schedule: twelveInstallments,
    },
  },
};

const pageCount = (pdf: Buffer): number =>
  (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

const render = (template: Builtin, doc: InvoiceDocument = SAMPLE_DOCUMENT) =>
  renderInvoiceHtml(template, invoiceView(doc));

describe("the built-ins", () => {
  it("are the three old ones and the three new ones", () => {
    expect(builtins.map((template) => template.name)).toEqual(NAMES);
  });

  describe.each(NAMES)("%s", (name) => {
    it("uses every tag", () => {
      const used = tagsIn(Mustache.parse(builtin(name).html) as Token[]);
      expect(REQUIRED.filter((tag) => !used.includes(tag))).toEqual([]);
    });

    it("has only tags the app fills in", () => {
      expect(checkTemplateTags(builtin(name).html)).toEqual([]);
    });

    it("passes the sanitiser unchanged in every way that matters", () => {
      const template = builtin(name);
      const result = sanitizeTemplate(template);
      expect(result.refused).toEqual([]);
      expect(result.tagIssues).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("shows the facts from the database, with money in its currency code", () => {
      const html = render(builtin(name));
      for (const expected of [
        "FPR-000042",
        "Rivera Studio",
        "sam@example.test",
        "Example Co",
        "500 Example Avenue, New York",
        "3 Nov 2026",
        "17 Nov 2026",
        "Website redesign: Build",
        "Net 14",
        "Late invoices incur 1.5% interest per month.",
        "Hello Sam,",
        "This invoice covers the Build milestone",
        "It&#39;s been a pleasure",
        "USD",
      ]) {
        expect(html, expected).toContain(expected);
      }
      expect(html).toMatch(/USD\s[\d,]+\.\d{2}/);
    });

    it("shows who it's from when there's no business name", () => {
      const html = render(builtin(name), {
        ...SAMPLE_DOCUMENT,
        freelancer: { ...SAMPLE_DOCUMENT.freelancer, businessName: null },
      });
      expect(html).toContain("Alex Rivera");
    });

    it("has a Pay online block with the PayPal link and the QR code", () => {
      const html = render(builtin(name));
      expect(html).toContain("Pay online");
      expect(html).toContain("#INV2-SAMP-LE00-0000");
      expect(html).toMatch(/<img[^>]*src="data:image&#x2F;gif;base64,/);
    });

    it("leaves the QR code out when it's off, and keeps the link", () => {
      const html = render(builtin(name), {
        ...SAMPLE_DOCUMENT,
        invoice: { ...SAMPLE_DOCUMENT.invoice, showQr: false },
      });
      expect(html).not.toContain("data:image&#x2F;gif");
      expect(html).toContain("#INV2-SAMP-LE00-0000");
    });

    it("shows the installment line only when it applies", () => {
      expect(render(builtin(name))).toMatch(/Installment\s+2\s+of\s+2/i);
      const plain = {
        ...SAMPLE_DOCUMENT,
        items: [{ name: "Build", description: null, quantity: 1, unitCents: 150_000 }],
        installment: null,
      };
      expect(render(builtin(name), plain)).not.toMatch(/Installment\s+\d+\s+of/i);
    });

    it("shows the signature only when the invoice has one", () => {
      const signed = render(builtin(name));
      expect(signed).toContain("Alex Rivera");
      expect(signed).toContain("Founder");
      expect(signed).toMatch(/<img[^>]*alt="Signature"/);
      const unsigned = render(builtin(name), { ...SAMPLE_DOCUMENT, signature: null });
      expect(unsigned).not.toMatch(/<img[^>]*alt="Signature"/);
      expect(unsigned).not.toContain("Founder");
    });

    it("asks for no bank details", () => {
      expect(builtin(name).html).not.toMatch(/\b(iban|swift|bic|bank|account no)\b/i);
    });

    it("loads nothing from outside", () => {
      const { html, css } = builtin(name);
      expect(`${html}${css}`).not.toMatch(/https?:\/\/|@import|url\(/i);
    });

    it("names only self-hosted fonts", () => {
      const families = [...builtin(name).css.matchAll(/font-family:\s*"([^"]+)"/g)].map(
        ([, family = ""]) => family,
      );
      expect(families.length).toBeGreaterThan(0);
      for (const family of families) expect(DOCUMENT_FONT_FAMILIES).toContain(family);
    });

    it("leaves the page size to the paper setting", () => {
      expect(builtin(name).css).not.toMatch(/size:\s*(A4|letter)/i);
    });
  });
});

describe("fitting on one page", () => {
  describe.each(NAMES)("%s", (name) => {
    describe.each(PAPERS)("on %s", (paper) => {
      it.each(Object.keys(LONGEST))(
        "%s",
        async (shape) => {
          const pdf = await renderPdf(render(builtin(name), LONGEST[shape]), paper);
          expect(pageCount(pdf)).toBe(1);
        },
        60_000,
      );
    });
  });
});

describe("counting pages", () => {
  it("sees a second page when a document really has one", async () => {
    const items = Array.from({ length: 70 }, () => ITEMS[0]).flatMap((item) =>
      item ? [item] : [],
    );
    const pdf = await renderPdf(render(builtin("Studio"), { ...SAMPLE_DOCUMENT, items }), "A4");
    expect(pageCount(pdf)).toBeGreaterThan(1);
  }, 60_000);
});

describe("the paper size", () => {
  const mediaBox = (pdf: Buffer): number[] => {
    const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(pdf.toString("latin1"));
    return [Number(match?.[1]), Number(match?.[2])];
  };

  it("A4 and US Letter come out at their real sizes", async () => {
    const template = builtin("Studio");
    const [a4Width, a4Height] = mediaBox(await renderPdf(render(template), "A4"));
    const [letterWidth, letterHeight] = mediaBox(await renderPdf(render(template), "Letter"));
    expect(a4Width).toBeCloseTo(594, -1);
    expect(a4Height).toBeCloseTo(842, -1);
    expect(letterWidth).toBeCloseTo(612, -1);
    expect(letterHeight).toBeCloseTo(792, -1);
  }, 60_000);
});

describe("the documents' fonts", () => {
  it("embeds only the families a template names, as data, so nothing loads", () => {
    const css = documentFontCss('body { font-family: "IBM Plex Mono", monospace; }');
    expect(css).toContain('font-family:"IBM Plex Mono"');
    expect(css).not.toContain("IBM Plex Serif");
    expect(css).toContain("url(data:font/woff2;base64,");
    expect(css).not.toMatch(/https?:/);
  });

  it("adds nothing for a template that uses system fonts", () => {
    expect(documentFontCss("body { font-family: Arial, sans-serif; }")).toBe("");
  });

  it("covers accented names, not just plain Latin", () => {
    const css = documentFontCss('body { font-family: "IBM Plex Sans"; }');
    expect(css).toContain("U+0100");
  });

  it("is what a rendered document carries", () => {
    const html = renderInvoiceHtml(
      { html: "<p>{{invoice.number}}</p>", css: 'p { font-family: "Instrument Sans"; }' },
      invoiceView(SAMPLE_DOCUMENT),
    );
    expect(html).toContain('font-family:"Instrument Sans"');
  });
});

describe("the pay link's QR code", () => {
  const LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-SAMP-LE00-0000";

  it("is an embedded image, made here", () => {
    expect(payQrDataUrl(LINK)).toMatch(/^data:image\/gif;base64,[A-Za-z0-9+/]+=*$/);
  });

  it("is the same every time, so a PDF doesn't look changed", () => {
    expect(payQrDataUrl(LINK)).toBe(payQrDataUrl(LINK));
  });

  it("differs for a different link", () => {
    expect(payQrDataUrl(`${LINK}1`)).not.toBe(payQrDataUrl(LINK));
  });

  it("gives nothing for a link too long to encode, rather than failing the invoice", () => {
    expect(payQrDataUrl("x".repeat(10_000))).toBe("");
  });
});

describe("the template picker's notes", () => {
  it("warns about ink on Noir", () => {
    const noir = builtins.find((template) => template.name === "Noir");
    expect(BUILTIN_TEMPLATE_NOTES[noir?.id ?? ""]).toBe(
      "Best on screen; uses a lot of ink if printed",
    );
  });
});
