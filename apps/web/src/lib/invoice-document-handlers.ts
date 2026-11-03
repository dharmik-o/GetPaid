import { routeTask } from "./ai-router";
import { loadAiConnections } from "./ai-settings";
import type { SecretBox } from "./crypto";
import { isUuid, type UserDbRunner } from "./db";
import { jsonResponse, notFound, serverError } from "./http";
import { getFreelancerDetails } from "./invoice-details";
import { loadMilestoneContext } from "./invoice-context";
import { invoicePdf, type PdfDeps } from "./invoice-pdfs";
import {
  checkedInvoiceTextSchema,
  invoiceTextMessages,
  invoiceTextTemplate,
  textFactsFor,
} from "./invoice-text";
import { logEvent } from "./log";

// Server-only: POST /api/milestones/[id]/invoice-text (the AI writes the document's text tags
// for the freelancer to read and edit before creating the invoice) and GET
// /api/invoices/[id]/pdf (the invoice document). Both run as the signed-in user.

type IdContext = { params: Promise<{ id: string }> };

export const invoiceTextHandler = (deps: { runAsUser: UserDbRunner; box: () => SecretBox }) => ({
  post: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Milestone");
    try {
      const prepared = await deps.runAsUser(async (db) => {
        const context = await loadMilestoneContext(db, id);
        const freelancer = await getFreelancerDetails(db);
        if (!context || !freelancer) return undefined;
        return {
          facts: textFactsFor(context, freelancer.name),
          connections: await loadAiConnections(db, "draft", deps.box()),
        };
      });
      if (!prepared) return notFound("Milestone");
      // Outside any transaction: a local model can take a minute.
      const result = await routeTask(prepared.connections, {
        messages: invoiceTextMessages(prepared.facts),
        schema: checkedInvoiceTextSchema(prepared.facts),
        template: invoiceTextTemplate(prepared.facts),
      });
      if (!result.ok) throw new Error("The router gave no text even with a template.");
      logEvent("invoice_text.drafted", { milestoneId: id, via: result.via });
      return jsonResponse({ text: result.output, via: result.via });
    } catch (error) {
      return serverError("invoice_text.failed", error);
    }
  },
});

export const invoicePdfHandler = (deps: () => PdfDeps) => ({
  get: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Invoice");
    try {
      const file = await invoicePdf(deps(), id);
      if (!file) return notFound("Invoice");
      return new Response(new Uint8Array(file.pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${file.filename}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof Error && /Chromium isn't installed/.test(error.message)) {
        logEvent("invoice_pdf.failed", { error: "chromium_missing" });
        return jsonResponse({ error: error.message }, 503);
      }
      return serverError("invoice_pdf.failed", error);
    }
  },
});
