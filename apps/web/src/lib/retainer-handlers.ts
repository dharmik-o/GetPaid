import { z } from "zod";
import type { UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import { PaypalError, type PaypalClient } from "./paypal";
import { cancelRetainer, setUpAutoPay, type RetainerFlowDeps } from "./retainer-flow";
import { createRetainer, dismissRetainerAlert, listRetainers } from "./retainers";

// Server-only: /api/retainers. Runs as the signed-in freelancer. PayPal is called only after the
// retainer is saved, so a failed call leaves something to retry.

type Deps = { runAsUser: UserDbRunner; paypal: () => PaypalClient; now: () => Date };
type IdContext = { params: Promise<{ id: string }> };

const RETAINER = "Retainer";

const PAYPAL_NOT_SET_UP =
  "PayPal isn't set up yet. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from your PayPal sandbox app to your local env file (see .env.example), then restart.";

const actionSchema = z.strictObject({
  action: z.enum(["setup", "cancel"], { error: "must be setup or cancel" }),
});

const failure = (event: string, error: unknown): Response => {
  if (!(error instanceof PaypalError)) return serverError(event, error);
  logEvent(event, { error: "PaypalError", status: error.status, issue: error.issue });
  return jsonResponse(
    { error: `${error.message} The retainer is saved: press Finish setup to try again.` },
    502,
  );
};

export const retainerHandlers = (deps: Deps) => {
  const flowDeps = (): RetainerFlowDeps | undefined => {
    try {
      return { runAsUser: deps.runAsUser, paypal: deps.paypal(), now: deps.now() };
    } catch {
      return undefined;
    }
  };

  return {
    list: async (): Promise<Response> => {
      try {
        const retainers = await deps.runAsUser((db) => listRetainers(db, deps.now()));
        return jsonResponse({ retainers });
      } catch (error) {
        return serverError("retainers.list_failed", error);
      }
    },

    create: async (request: Request): Promise<Response> => {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      try {
        const created = await deps.runAsUser((db) => createRetainer(db, read.body, deps.now()));
        if (!created.ok) return fieldErrors(created.errors);
        if (created.method === "invoice") return jsonResponse({ id: created.id }, 201);
        const flow = flowDeps();
        if (!flow) {
          return jsonResponse({ error: PAYPAL_NOT_SET_UP }, 503);
        }
        await setUpAutoPay(flow, created.id);
        return jsonResponse({ id: created.id }, 201);
      } catch (error) {
        return failure("retainers.create_failed", error);
      }
    },

    act: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = actionSchema.safeParse(read.body);
      if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
      const flow = flowDeps();
      if (!flow) return jsonResponse({ error: PAYPAL_NOT_SET_UP }, 503);
      try {
        const result =
          parsed.data.action === "setup"
            ? await setUpAutoPay(flow, id)
            : await cancelRetainer(flow, id);
        return result === "not_found" ? notFound(RETAINER) : noContent();
      } catch (error) {
        return failure("retainers.action_failed", error);
      }
    },

    dismissAlert: async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      try {
        const done = await deps.runAsUser((db) => dismissRetainerAlert(db, id, deps.now()));
        return done ? noContent() : notFound("Alert");
      } catch (error) {
        return serverError("retainers.dismiss_failed", error);
      }
    },
  };
};
