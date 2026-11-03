import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InvoicePanel, type InvoiceRowData } from "@/components/InvoicePanel";

// The Invoices card, rendered on the server as the project page does: plain invoices,
// installments, deposits and setup plans each show the right lines and actions.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const base: Omit<InvoiceRowData, "milestoneId"> = {
  name: "Build",
  cents: 150000,
  paymentMode: "pay_on_invoice",
  status: "delivered",
  invoices: [],
  plan: null,
};

const invoice = (overrides: Partial<InvoiceRowData["invoices"][number]>) => ({
  id: "i1",
  invoiceNumber: "FPR-000001",
  status: "sent",
  amountCents: 75000,
  amountPaidCents: 0,
  dueDate: "2026-11-15",
  link: "https://www.sandbox.paypal.com/invoice/p/#INV2-1",
  installment: null,
  ...overrides,
});

const render = (rows: InvoiceRowData[]) =>
  renderToStaticMarkup(createElement(InvoicePanel, { currency: "USD", today: "2026-11-03", rows }))
    .replace(/\u00a0/gu, " ")
    .replace(/<!-- -->/gu, "");

describe("InvoicePanel", () => {
  it("explains what to do when there are no milestones", () => {
    expect(render([])).toMatch(/add one milestone at 100%/);
  });

  it("offers one invoice or installments for delivered pay-on-invoice work", () => {
    const html = render([{ ...base, milestoneId: "m1" }]);
    expect(html).toContain("Create invoice");
    expect(html).toContain("Pay in installments");
    expect(html).toContain("No invoice yet");
  });

  it("shows a saved setup plan and creates all its installments together", () => {
    const html = render([
      {
        ...base,
        milestoneId: "m1",
        plan: {
          createdFrom: "setup",
          items: [
            { amountCents: 75000, dueDate: "2026-11-03" },
            { amountCents: 75000, dueDate: "2026-11-15" },
          ],
        },
      },
    ]);
    expect(html).toContain("Create 2 installment invoices");
    expect(html).toContain("USD 750.00 due 15 Nov");
    expect(html).toContain("Use one invoice");
  });

  it("lists each installment with its pay link, and cancels the plan as a whole", () => {
    const html = render([
      {
        ...base,
        milestoneId: "m1",
        status: "invoiced",
        invoices: [
          invoice({ id: "i1", installment: { number: 1, count: 2 }, dueDate: "2026-11-03" }),
          invoice({ id: "i2", installment: { number: 2, count: 2 }, invoiceNumber: "FPR-000002" }),
        ],
        plan: { createdFrom: "setup", items: [] },
      },
    ]);
    expect(html).toContain("Installment 1 of 2: USD 750.00");
    expect(html).toContain("Installment 2 of 2: USD 750.00");
    expect(html.match(/PayPal pay link/gu)).toHaveLength(2);
    expect(html).toContain("Cancel installment plan");
    expect(html).not.toContain("Pay in installments");
  });

  it("offers the rest of a deposit once installment 1 exists, and no cancel once paid", () => {
    const html = render([
      {
        ...base,
        milestoneId: "m1",
        name: "Design",
        cents: 90000,
        paymentMode: "deposit",
        status: "partially_paid",
        invoices: [
          invoice({
            status: "paid",
            amountCents: 30000,
            amountPaidCents: 30000,
            installment: { number: 1, count: 2 },
          }),
        ],
        plan: {
          createdFrom: "deposit",
          items: [
            { amountCents: 30000, dueDate: null },
            { amountCents: 60000, dueDate: null },
          ],
        },
      },
    ]);
    expect(html).toContain("Work delivered: invoice the rest (USD 600.00)");
    expect(html).toContain("Paid USD 300.00");
    expect(html).not.toContain("Cancel");
  });

  it("asks for the deposit amount on a deposit milestone with no invoice", () => {
    const html = render([
      { ...base, milestoneId: "m1", paymentMode: "deposit", status: "planned", cents: 90000 },
    ]);
    expect(html).toContain("Deposit due at kickoff (USD)");
    expect(html).toContain("Create deposit invoice");
    expect(html).not.toContain("Pay in installments");
  });
});

describe("InvoicePanel: the invoice document", () => {
  const TEMPLATES = [
    { id: "t1", name: "Classic" },
    { id: "t2", name: "My template" },
  ];

  it("offers a template pick and AI-written text before creating the invoice", () => {
    const html = renderToStaticMarkup(
      createElement(InvoicePanel, {
        currency: "USD",
        today: "2026-11-03",
        rows: [{ ...base, milestoneId: "m1" }],
        templates: TEMPLATES,
      }),
    );
    expect(html).toContain("Invoice document (PDF)");
    expect(html).toContain(">Default for this client</option>");
    expect(html).toContain('<option value="t2">My template</option>');
    expect(html).toContain("Write the text with AI");
  });

  it("links each sent invoice's PDF", () => {
    const html = render([
      { ...base, milestoneId: "m1", status: "invoiced", invoices: [invoice({})] },
    ]);
    expect(html).toContain('href="/api/invoices/i1/pdf"');
  });
});
