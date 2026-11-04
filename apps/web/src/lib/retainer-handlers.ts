import { z } from "zod";
import { isUuid, type UserDbRunner } from "./db";
import type { DrafterDeps } from "./drafter";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import { errorKind, logEvent } from "./log";
import { PaypalError, type PaypalClient } from "./paypal";
import { draftApprovalEmail } from "./retainer-approval-email";
import { cancelRetainer, setUpAutoPay, type RetainerFlowDeps } from "./retainer-flow";
import { createRetainer, dismissRetainerAlert, listRetainers } from "./retainers";

// Server-only: /api/retainers. Runs as the signed-in freelancer. PayPal is called only after the
// retainer is saved, so a failed call leaves something to retry.

type Deps = DrafterDeps & {
  /** The signed-in freelancer. */
  currentUser: () => string;
  runAsCurrent: UserDbRunner;
  paypal: () => PaypalClient;
};
type IdContext = { params: Promise<{ id: string }> };

const RETAINER = "Retainer";

const PAYPAL_NOT_SET_UP =
  "PayPal isn't set up yet. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from your PayPal sandbox app to your local env file (see .env.example), then restart.";

const actionSchema = z.strictObject({
  action: z.enum(["setup", "cancel", "email"], { error: "must be setup, cancel or email" }),
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
      return { runAsUser: deps.runAsCurrent, paypal: deps.paypal(), now: deps.now() };
    } catch {
      return undefined;
    }
  };

  /** Once PayPal gave a link. If the model call fails, the scheduler writes the draft. */
  const draftEmail = async (retainerId: string): Promise<void> => {
    try {
      await draftApprovalEmail(deps, { userId: deps.currentUser(), retainerId });
    } catch (error) {
      logEvent("retainers.approval_email_failed", { retainerId, error: errorKind(error) });
    }
  };

  /** The freelancer asked for another, after skipping one. */
  const askForEmail = async (id: string): Promise<Response> => {
    if (!isUuid(id)) return notFound(RETAINER);
    try {
      const result = await draftApprovalEmail(deps, {
        userId: deps.currentUser(),
        retainerId: id,
        evenIfSkipped: true,
      });
      if (result === "not_found") return notFound(RETAINER);
      if (result === "not_ready") {
        return jsonResponse(
          { error: "This retainer isn't waiting for the client's approval, so there's no link to send." },
          409,
        );
      }
      return noContent();
    } catch (error) {
      return serverError("retainers.approval_email_failed", error);
    }
  };

  return {
    list: async (): Promise<Response> => {
      try {
        const retainers = await deps.runAsCurrent((db) => listRetainers(db, deps.now()));
        return jsonResponse({ retainers });
      } catch (error) {
        return serverError("retainers.list_failed", error);
      }
    },

    create: async (request: Request): Promise<Response> => {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      try {
        const created = await deps.runAsCurrent((db) =>
          createRetainer(db, read.body, deps.now()),
        );
        if (!created.ok) return fieldErrors(created.errors);
        if (created.method === "invoice") return jsonResponse({ id: created.id }, 201);
        const flow = flowDeps();
        if (!flow) {
          return jsonResponse({ error: PAYPAL_NOT_SET_UP }, 503);
        }
        await setUpAutoPay(flow, created.id);
        await draftEmail(created.id);
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
      if (parsed.data.action === "email") return askForEmail(id);
      const flow = flowDeps();
      if (!flow) return jsonResponse({ error: PAYPAL_NOT_SET_UP }, 503);
      try {
        const setUp = parsed.data.action === "setup";
        const result = setUp ? await setUpAutoPay(flow, id) : await cancelRetainer(flow, id);
        if (result === "not_found") return notFound(RETAINER);
        if (setUp && result === "ok") await draftEmail(id);
        return noContent();
      } catch (error) {
        return failure("retainers.action_failed", error);
      }
    },

    dismissAlert: async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      try {
        const done = await deps.runAsCurrent((db) => dismissRetainerAlert(db, id, deps.now()));
        return done ? noContent() : notFound("Alert");
      } catch (error) {
        return serverError("retainers.dismiss_failed", error);
      }
    },
  };
};
