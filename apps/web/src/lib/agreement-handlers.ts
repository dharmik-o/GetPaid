import { z } from "zod";
import {
  createDraft,
  getAgreement,
  listAgreements,
  newVersion,
  previewAgreement,
  updateDraft,
  voidAgreement,
  type Context,
  type Failure,
  type Saved,
} from "./agreements";
import { isUuid, type Db, type UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: the /api/agreements route handlers. `runAsUser` and the clock and law table are
// injected so tests drive the same code against an in-memory database with real row-level security.

type Deps = { runAsUser: UserDbRunner; context: () => Context };
type IdContext = { params: Promise<{ id: string }> };

const AGREEMENT = "Agreement";

const projectBody = z.strictObject({
  projectId: z
    .string({ error: "must be one of your projects" })
    .refine(isUuid, "must be one of your projects"),
  options: z.unknown().optional(),
});
const optionsBody = z.strictObject({ options: z.unknown() });

const failure = (result: Failure): Response => {
  if ("errors" in result) return fieldErrors(result.errors);
  if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
  return notFound(AGREEMENT);
};

export const agreementHandlers = ({ runAsUser, context }: Deps) => {
  const saved = (event: string, result: Saved, status = 200): Response => {
    if (!result.ok) return failure(result);
    logEvent(event, { agreementId: result.agreement.id });
    return jsonResponse({ agreement: result.agreement }, status);
  };

  /** Runs `work` on an agreement by id, as the signed-in user. */
  const onId =
    (event: string, work: (db: Db, id: string) => Promise<Saved>) =>
    async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(AGREEMENT);
      try {
        return saved(event, await runAsUser((db) => work(db, id)));
      } catch (error) {
        return serverError(`${event}_failed`, error);
      }
    };

  /** Reads `{ projectId, options }`, then runs `work`. */
  const onProject =
    (event: string, work: (db: Db, projectId: string, options: unknown) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = projectBody.safeParse(read.body);
      if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
      try {
        return await runAsUser((db) => work(db, parsed.data.projectId, parsed.data.options ?? {}));
      } catch (error) {
        return serverError(`${event}_failed`, error);
      }
    };

  return {
    list: async (request: Request): Promise<Response> => {
      const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
      if (!isUuid(projectId)) return notFound("Project");
      try {
        return jsonResponse({ agreements: await runAsUser((db) => listAgreements(db, projectId)) });
      } catch (error) {
        return serverError("agreements.list", error);
      }
    },

    preview: onProject("agreements.preview", async (db, projectId, options) => {
      const result = await previewAgreement(db, projectId, options, context());
      return result.ok
        ? jsonResponse({ html: result.html, options: result.options })
        : failure(result);
    }),

    create: onProject("agreements.create", async (db, projectId, options) =>
      saved("agreements.created", await createDraft(db, projectId, options, context()), 201),
    ),

    get: async (_request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(AGREEMENT);
      try {
        const agreement = await runAsUser((db) => getAgreement(db, id));
        return agreement ? jsonResponse({ agreement }) : notFound(AGREEMENT);
      } catch (error) {
        return serverError("agreements.get", error);
      }
    },

    update: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(AGREEMENT);
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = optionsBody.safeParse(read.body);
      if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
      try {
        const result = await runAsUser((db) => updateDraft(db, id, parsed.data.options, context()));
        return saved("agreements.updated", result);
      } catch (error) {
        return serverError("agreements.update", error);
      }
    },

    void: onId("agreements.voided", voidAgreement),
    newVersion: onId("agreements.new_version", (db, id) => newVersion(db, id, context())),
  };
};
