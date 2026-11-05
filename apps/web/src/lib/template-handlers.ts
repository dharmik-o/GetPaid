import { z } from "zod";
import { isUuid, type UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import {
  getClientDetails,
  getFreelancerDetails,
  saveClientDetails,
  saveFreelancerDetails,
} from "./invoice-details";
import { invoiceView, SAMPLE_DOCUMENT, type InvoiceDocument } from "./invoice-document";
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  templateBodySchema,
  updateTemplate,
  type SaveTemplateResult,
} from "./invoice-templates";
import { errorKind, logEvent } from "./log";
import { DOCUMENT_CSP, renderInvoiceHtml } from "./template-render";
import { sanitizeTemplate } from "./template-sanitize";

// Server-only: Settings > Invoice templates, the template editor's live preview, and the
// invoice details for the freelancer and each client. Everything runs as the signed-in user.

type Deps = {
  runAsUser: UserDbRunner;
  /** Draws a typed name. Only the route that saves the details needs it. */
  renderSignature?: (name: string) => Promise<string>;
};
type IdContext = { params: Promise<{ id: string }> };

const TEMPLATE = "Template";
const CLIENT = "Client";

const duplicateSchema = z.strictObject({ duplicateOf: z.uuid({ error: "must be a template id" }) });
const previewSchema = z.strictObject({
  html: z.string({ error: "is required" }),
  css: z.string().default(""),
});

const typedRequest = z.looseObject({
  signatureSource: z.literal("typed"),
  signatureTypedName: z.string().trim().min(1).max(120),
});

/**
 * A typed signature's image always comes from here, never from the request. It's drawn before the
 * transaction, as it starts a browser, and only when the name changed.
 */
const withDrawnSignature = async (deps: Deps, raw: unknown): Promise<unknown> => {
  const typed = typedRequest.safeParse(raw);
  if (!typed.success) return raw;
  const name = typed.data.signatureTypedName;
  const current = await deps.runAsUser((db) => getFreelancerDetails(db));
  if (current?.signatureTypedName === name && current.signatureImageDataUrl) {
    return { ...typed.data, signatureImageDataUrl: current.signatureImageDataUrl };
  }
  if (!deps.renderSignature) throw new Error("This route can't draw a typed signature.");
  try {
    return { ...typed.data, signatureImageDataUrl: await deps.renderSignature(name) };
  } catch (error) {
    logEvent("invoice_details.signature_failed", { error: errorKind(error) });
    return jsonResponse(
      { error: "The typed signature couldn't be drawn. Upload an image instead, or try again." },
      503,
    );
  }
};

const saved = (result: SaveTemplateResult | undefined, status = 200): Response => {
  if (!result) return notFound(TEMPLATE);
  if (!result.ok) {
    return jsonResponse(
      {
        error: "This template can't be saved yet. Fix the problems shown and save again.",
        errors: result.errors,
        removed: result.sanitized?.removed ?? [],
      },
      400,
    );
  }
  return jsonResponse({ template: result.template, removed: result.removed }, status);
};

/** The sample data, with the freelancer's own name, business and logo so the preview looks real. */
const previewDocument = (
  details: Awaited<ReturnType<typeof getFreelancerDetails>>,
): InvoiceDocument =>
  details
    ? {
        ...SAMPLE_DOCUMENT,
        freelancer: {
          name: details.name,
          businessName: details.businessName,
          email: details.email,
          address: details.address,
          logoDataUrl: details.logoDataUrl,
        },
        invoice: { ...SAMPLE_DOCUMENT.invoice, showQr: details.invoiceShowQr },
        signature: details.signatureImageDataUrl
          ? {
              imageDataUrl: details.signatureImageDataUrl,
              name: details.signatureName,
              title: details.signatureTitle,
            }
          : SAMPLE_DOCUMENT.signature,
      }
    : SAMPLE_DOCUMENT;

export const templateHandlers = ({ runAsUser, renderSignature }: Deps) => ({
  list: async (): Promise<Response> => {
    try {
      const result = await runAsUser(async (db) => ({
        templates: await listTemplates(db),
        details: await getFreelancerDetails(db),
      }));
      return jsonResponse(result);
    } catch (error) {
      return serverError("templates.list_failed", error);
    }
  },

  create: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const duplicate = duplicateSchema.safeParse(body.body);
    const fields = duplicate.success ? undefined : templateBodySchema.safeParse(body.body);
    if (fields && !fields.success) {
      return fieldErrors(toFieldIssues(fields.error, { noun: "field" }));
    }
    try {
      const result = await runAsUser((db) =>
        duplicate.success
          ? duplicateTemplate(db, duplicate.data.duplicateOf)
          : createTemplate(db, fields?.data ?? { name: "", html: "", css: "" }),
      );
      if (result?.ok) logEvent("templates.created", { templateId: result.template.id });
      return saved(result, 201);
    } catch (error) {
      return serverError("templates.create_failed", error);
    }
  },

  /** The gallery's thumbnail: the template on sample data, as a page that can do nothing. */
  thumbnail: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(TEMPLATE);
    try {
      const loaded = await runAsUser(async (db) => ({
        template: await getTemplate(db, id),
        details: await getFreelancerDetails(db),
      }));
      if (!loaded.template) return notFound(TEMPLATE);
      const html = renderInvoiceHtml(loaded.template, invoiceView(previewDocument(loaded.details)));
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `${DOCUMENT_CSP}; sandbox; frame-ancestors 'self'`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    } catch (error) {
      return serverError("templates.thumbnail_failed", error);
    }
  },

  get: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(TEMPLATE);
    try {
      const template = await runAsUser((db) => getTemplate(db, id));
      return template ? jsonResponse({ template }) : notFound(TEMPLATE);
    } catch (error) {
      return serverError("templates.get_failed", error);
    }
  },

  update: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(TEMPLATE);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const fields = templateBodySchema.safeParse(body.body);
    if (!fields.success) return fieldErrors(toFieldIssues(fields.error, { noun: "field" }));
    try {
      const result = await runAsUser((db) => updateTemplate(db, id, fields.data));
      if (result?.ok) logEvent("templates.updated", { templateId: id });
      return saved(result);
    } catch (error) {
      return serverError("templates.update_failed", error);
    }
  },

  remove: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(TEMPLATE);
    try {
      const deleted = await runAsUser((db) => deleteTemplate(db, id));
      if (!deleted) return notFound(TEMPLATE);
      logEvent("templates.deleted", { templateId: id });
      return noContent();
    } catch (error) {
      return serverError("templates.delete_failed", error);
    }
  },

  /** The editor's live preview: sanitised as on save, filled with sample data. Saves nothing. */
  preview: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = previewSchema.safeParse(body.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const details = await runAsUser((db) => getFreelancerDetails(db));
      const result = sanitizeTemplate(parsed.data);
      const document =
        result.tagIssues.length === 0
          ? renderInvoiceHtml(result, invoiceView(previewDocument(details)))
          : null;
      return jsonResponse({
        document,
        removed: result.removed,
        refused: result.refused,
        tagIssues: result.tagIssues,
      });
    } catch (error) {
      return serverError("templates.preview_failed", error);
    }
  },

  saveDetails: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const prepared = await withDrawnSignature(
        { runAsUser, ...(renderSignature ? { renderSignature } : {}) },
        body.body,
      );
      if (prepared instanceof Response) return prepared;
      const result = await runAsUser((db) => saveFreelancerDetails(db, prepared));
      if (!result.ok) return fieldErrors(result.errors);
      // Whether there's a signature, and never the image.
      logEvent("invoice_details.saved", {
        hasLogo: result.value.logoDataUrl !== null,
        hasSignature: result.value.signatureSource !== null,
      });
      return jsonResponse({ details: result.value });
    } catch (error) {
      return serverError("invoice_details.save_failed", error);
    }
  },

  getClientDetails: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(CLIENT);
    try {
      const details = await runAsUser((db) => getClientDetails(db, id));
      return details ? jsonResponse({ details }) : notFound(CLIENT);
    } catch (error) {
      return serverError("client_invoice_details.get_failed", error);
    }
  },

  saveClientDetails: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(CLIENT);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => saveClientDetails(db, id, body.body));
      if (!result) return notFound(CLIENT);
      if (!result.ok) return fieldErrors(result.errors);
      logEvent("client_invoice_details.saved", { clientId: id });
      return jsonResponse({ details: result.value });
    } catch (error) {
      return serverError("client_invoice_details.save_failed", error);
    }
  },
});
