import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import { createProject, getProject, updateProject, type ProjectResult } from "./projects";

// Server-only: the /api/projects route handlers. `runAsUser` is injected so tests can drive
// the same code against an in-memory database with real row-level security.

type Deps = { runAsUser: UserDbRunner };
type IdContext = { params: Promise<{ id: string }> };

const PROJECT = "Project";

const toResponse = (result: ProjectResult, status: number): Response => {
  if (result.ok)
    return jsonResponse({ project: result.project, warnings: result.warnings }, status);
  return "notFound" in result ? notFound(PROJECT) : fieldErrors(result.errors);
};

export const projectHandlers = ({ runAsUser }: Deps) => ({
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
