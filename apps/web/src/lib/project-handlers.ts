import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import { archiveProject, completeProject, restoreProject } from "./project-complete";
import { deleteProject, type DeleteProjectDeps } from "./project-delete";
import { PaypalError } from "./paypal";
import { createProject, getProject, updateProject, type ProjectResult } from "./projects";

// Server-only: the /api/projects route handlers. `runAsUser` is injected so tests can drive
// the same code against an in-memory database with real row-level security.

type Deps = {
  runAsUser: UserDbRunner;
  /** What deleting needs to cancel invoices and void holds in PayPal first. */
  deleting?: () => DeleteProjectDeps | undefined;
};
type IdContext = { params: Promise<{ id: string }> };

const PROJECT = "Project";

const toResponse = (result: ProjectResult, status: number): Response => {
  if (result.ok)
    return jsonResponse({ project: result.project, warnings: result.warnings }, status);
  return "notFound" in result ? notFound(PROJECT) : fieldErrors(result.errors);
};

export const projectHandlers = ({ runAsUser, deleting }: Deps) => ({
  create: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => createProject(db, body.body));
      if (result.ok) logEvent("projects.created", { projectId: result.project.id });
      return toResponse(result, 201);
    } catch (error) {
      return serverError("projects.create_failed", error);
    }
  },

  get: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    try {
      const project = await runAsUser((db) => getProject(db, id));
      return project ? jsonResponse({ project }) : notFound(PROJECT);
    } catch (error) {
      return serverError("projects.get_failed", error);
    }
  },

  complete: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    try {
      const result = await runAsUser((db) => completeProject(db, id));
      if (result.ok) {
        logEvent("projects.completed", { projectId: id });
        return jsonResponse({ done: "complete" });
      }
      return "notFound" in result
        ? notFound(PROJECT)
        : jsonResponse({ error: result.conflict }, 409);
    } catch (error) {
      return serverError("projects.complete_failed", error);
    }
  },

  archive: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    try {
      const result = await runAsUser((db) => archiveProject(db, id));
      if (!result.ok) return notFound(PROJECT);
      logEvent("projects.archived", { projectId: id });
      return jsonResponse({ done: "archive" });
    } catch (error) {
      return serverError("projects.archive_failed", error);
    }
  },

  restore: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    try {
      const result = await runAsUser((db) => restoreProject(db, id));
      if (!result.ok) return notFound(PROJECT);
      logEvent("projects.restored", { projectId: id });
      return jsonResponse({ done: "restore" });
    } catch (error) {
      return serverError("projects.restore_failed", error);
    }
  },

  remove: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const flow = deleting?.();
    if (!flow) {
      return jsonResponse(
        {
          error:
            "PayPal isn't set up yet, so open invoices can't be checked. Set it up, then try again.",
        },
        503,
      );
    }
    try {
      const result = await deleteProject(flow, id, body.body);
      if (result.ok) {
        logEvent("projects.deleted", { projectId: id });
        return jsonResponse({ deleted: true });
      }
      if ("notFound" in result) return notFound(PROJECT);
      if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
      return fieldErrors(result.errors);
    } catch (error) {
      if (error instanceof PaypalError) {
        logEvent("projects.delete_paypal_failed", { status: error.status, issue: error.issue });
        return jsonResponse({ error: `${error.message} Nothing was deleted.` }, 502);
      }
      return serverError("projects.delete_failed", error);
    }
  },

  update: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(PROJECT);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => updateProject(db, id, body.body));
      if (result.ok) logEvent("projects.updated", { projectId: id });
      return toResponse(result, 200);
    } catch (error) {
      return serverError("projects.update_failed", error);
    }
  },
});
