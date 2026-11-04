import {
  createClient,
  deleteClient,
  getClient,
  listClients,
  parseClientCreate,
  parseClientUpdate,
  updateClient,
} from "./clients";
import { isUuid, type UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, noContent, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: the /api/clients route handlers. `runAsUser` is injected so tests can drive
// the same code against an in-memory database with real row-level security.

type Deps = { runAsUser: UserDbRunner };
type IdContext = { params: Promise<{ id: string }> };

const CLIENT = "Client";

export const clientHandlers = ({ runAsUser }: Deps) => ({
  list: async (): Promise<Response> => {
    try {
      return jsonResponse({ clients: await runAsUser((db) => listClients(db)) });
    } catch (error) {
      return serverError("clients.list_failed", error);
    }
  },

  create: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = parseClientCreate(body.body);
    if (!parsed.ok) return fieldErrors(parsed.errors);
    try {
      const client = await runAsUser((db) => createClient(db, parsed.value));
      logEvent("clients.created", { clientId: client.id });
      return jsonResponse({ client }, 201);
    } catch (error) {
      return serverError("clients.create_failed", error);
    }
  },

  get: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(CLIENT);
    try {
      const client = await runAsUser((db) => getClient(db, id));
      return client ? jsonResponse({ client }) : notFound(CLIENT);
    } catch (error) {
      return serverError("clients.get_failed", error);
    }
  },

  update: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(CLIENT);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = parseClientUpdate(body.body);
    if (!parsed.ok) return fieldErrors(parsed.errors);
    try {
      const client = await runAsUser((db) => updateClient(db, id, parsed.value));
      if (!client) return notFound(CLIENT);
      logEvent("clients.updated", { clientId: id });
      return jsonResponse({ client });
    } catch (error) {
      return serverError("clients.update_failed", error);
    }
  },

  remove: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound(CLIENT);
    try {
      const result = await runAsUser((db) => deleteClient(db, id));
      if (result === "not_found") return notFound(CLIENT);
      if (result === "has_auto_pay") {
        return jsonResponse(
          {
            error:
              "This client has auto-pay set up, and PayPal would keep charging them. Cancel the retainer under Retainers first, then delete the client.",
          },
          409,
        );
      }
      logEvent("clients.deleted", { clientId: id });
      return noContent();
    } catch (error) {
      return serverError("clients.delete_failed", error);
    }
  },
});
