import type { UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { cancelInvoice } from "./invoice-cancel";
import { recordPayment } from "./invoice-payments";
import { issueMilestoneInvoice, type InvoiceResult } from "./invoice-flow";
import { logEvent } from "./log";
import { PaypalError, type PaypalClient } from "./paypal";

// Server-only: POST /api/milestones/[id]/invoice, POST /api/invoices/[id]/cancel (with a reason)
// and POST /api/invoices/[id]/payments (money received outside PayPal).
// Both answer { invoices }: one plain invoice, or the installments the request covered.
// The database runner, PayPal client and clock are injected so tests can mock all three.

type Deps = {
  runAsUser: UserDbRunner;
  paypal: () => PaypalClient;
  now: () => Date;
  /** Makes the invoice's PDF after it's sent (optional: tests leave it out). */
  pdf?: (invoiceId: string) => Promise<unknown>;
};
type IdContext = { params: Promise<{ id: string }> };

const PAYPAL_NOT_SET_UP =
  "PayPal isn't set up yet. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from your PayPal sandbox app to your local env file (see .env.example), then restart.";

const respond = (result: InvoiceResult, what: string): Response => {
  if (result.ok) return jsonResponse({ invoices: result.invoices }, result.sentNow ? 201 : 200);
  if ("notFound" in result) return notFound(what);
  if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
  return fieldErrors(result.errors);
};

/** PayPal's own refusals are safe to show (issue code, its short reason, debug id); others aren't. */
const failure = (event: string, error: unknown): Response => {
  if (!(error instanceof PaypalError)) return serverError(event, error);
  logEvent(event, {
    error: "PaypalError",
    status: error.status,
    issue: error.issue,
    debugId: error.debugId,
  });
  return jsonResponse({ error: error.message }, 502);
};

export const invoiceHandlers = (deps: Deps) => {
  const flowDeps = (): Parameters<typeof issueMilestoneInvoice>[0] | undefined => {
    try {
      return {
        runAsUser: deps.runAsUser,
        paypal: deps.paypal(),
        now: deps.now(),
        ...(deps.pdf ? { pdf: deps.pdf } : {}),
      };
    } catch {
      return undefined;
    }
  };

  const run = async (
    event: string,
    what: string,
    work: (flow: NonNullable<ReturnType<typeof flowDeps>>) => Promise<InvoiceResult>,
  ): Promise<Response> => {
    const flow = flowDeps();
    if (!flow) {
      logEvent(`${event}_failed`, { error: "paypal_not_configured" });
      return jsonResponse({ error: PAYPAL_NOT_SET_UP }, 503);
    }
    try {
      const result = await work(flow);
      if (result.ok && result.sentNow) {
        logEvent(event, { invoiceIds: result.invoices.map((invoice) => invoice.id).join(",") });
      }
      return respond(result, what);
    } catch (error) {
      return failure(`${event}_failed`, error);
    }
  };

  return {
    issue: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      const body = await readJson(request);
      if (!body.ok) return body.response;
      return run("invoices.sent", "Milestone", (flow) =>
        issueMilestoneInvoice(flow, id, body.body),
      );
    },

    cancel: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      const body = await readJson(request);
      if (!body.ok) return body.response;
      return run("invoices.cancelled", "Invoice", (flow) => cancelInvoice(flow, id, body.body));
    },

    recordPayment: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      const body = await readJson(request);
      if (!body.ok) return body.response;
      return run("invoices.payment_recorded", "Invoice", (flow) =>
        recordPayment(flow, id, body.body),
      );
    },
  };
};
