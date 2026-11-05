import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { CLASSIC_TEMPLATE_ID } from "@/lib/invoice-templates";
import { templateHandlers } from "@/lib/template-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// Settings > Invoice templates, the editor's preview, and the invoice details: real
// migrations and RLS (PGlite).

let handle: TestDatabase;
const MODERN = "00000000-0000-4000-8000-00000000c002";
const LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);
const as = (userId = USER_A.userId) => templateHandlers({ runAsUser: runnerFor(userId) });

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const id = (value: string) => ({ params: Promise.resolve({ id: value }) });
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Saved = {
  template: { id: string; name: string; kind: string; html: string };
  removed: string[];
};
type Refused = { errors: { field: string; message: string }[]; removed: string[] };

const create = (body: unknown, userId = USER_A.userId) => as(userId).create(request("POST", body));

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

beforeEach(async () => {
  await handle.db.query("UPDATE public.users SET default_template_id = NULL, logo_data_url = NULL");
  await handle.db.query("UPDATE public.clients SET default_template_id = NULL");
  await handle.db.query("DELETE FROM public.invoice_templates WHERE kind = 'custom'");
});

afterAll(async () => {
  await handle.close();
});

describe("templates", () => {
  it("lists the built-ins first, then the user's own", async () => {
    await create({ name: "Mine", html: "<p>{{greeting}}</p>" });
    const { templates } = await json<{ templates: { name: string; kind: string }[] }>(
      await as().list(),
    );
    expect(templates.map((t) => [t.name, t.kind])).toEqual([
      ["Classic", "builtin"],
      ["Modern", "builtin"],
      ["Minimal", "builtin"],
      ["Studio", "builtin"],
      ["Ledger", "builtin"],
      ["Noir", "builtin"],
      ["Mine", "custom"],
    ]);
  });

  it("sanitises on save and says what it removed", async () => {
    const response = await create({
      name: "Mine",
      html: `<p onclick="steal()">{{client.name}}</p><script>alert(1)</script>`,
      css: "p { color: teal; behavior: url(x.htc); }",
    });
    expect(response.status).toBe(201);
    const { template, removed } = await json<Saved>(response);
    expect(template.html).toBe("<p>{{client.name}}</p>");
    expect(removed).toEqual(
      expect.arrayContaining(["the onclick event handler", "the <script> element"]),
    );
  });

  it("refuses a template with a remote image, and saves nothing", async () => {
    const response = await create({ name: "Tracker", html: `<img src="https://x.example/p.png">` });
    expect(response.status).toBe(400);
    const { errors } = await json<Refused>(response);
    expect(errors[0]).toMatchObject({
      field: "html",
      message: expect.stringMatching(/remote image/) as string,
    });
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.invoice_templates WHERE name = 'Tracker'",
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses an unknown tag, naming its line", async () => {
    const response = await create({ name: "Mine", html: "<p>ok</p>\n<p>{{client.phone}}</p>" });
    const { errors } = await json<Refused>(response);
    expect(errors).toEqual([
      { field: "html", message: "line 2: {{client.phone}} isn't a tag this app fills in" },
    ]);
  });

  it("duplicates a built-in into an editable copy", async () => {
    const response = await create({ duplicateOf: MODERN });
    expect(response.status).toBe(201);
    const { template } = await json<Saved>(response);
    expect(template).toMatchObject({ name: "Modern (copy)", kind: "custom" });
    const edited = await as().update(
      request("PUT", { name: "My modern", html: "<p>{{greeting}}</p>", css: "" }),
      id(template.id),
    );
    expect(edited.status).toBe(200);
  });

  it("can't edit or delete a built-in", async () => {
    const body = { name: "Hacked", html: "<p>x</p>", css: "" };
    expect((await as().update(request("PUT", body), id(CLASSIC_TEMPLATE_ID))).status).toBe(404);
    expect((await as().remove(request("DELETE"), id(CLASSIC_TEMPLATE_ID))).status).toBe(404);
  });

  it("can't read, edit or delete another user's template (RLS)", async () => {
    const { template } = await json<Saved>(await create({ name: "A's", html: "<p>{{notes}}</p>" }));
    const b = as(USER_B.userId);
    expect((await b.get(request("GET"), id(template.id))).status).toBe(404);
    expect(
      (await b.update(request("PUT", { name: "x", html: "<p>x</p>" }), id(template.id))).status,
    ).toBe(404);
    expect((await b.remove(request("DELETE"), id(template.id))).status).toBe(404);
    expect((await b.create(request("POST", { duplicateOf: template.id }))).status).toBe(404);
  });
});

describe("preview", () => {
  type Preview = {
    document: string | null;
    removed: string[];
    refused: string[];
    tagIssues: unknown[];
  };
  const preview = async (html: string, css = "") =>
    json<Preview>(await as().preview(request("POST", { html, css })));

  it("fills the sample data, with the freelancer's own name and logo", async () => {
    await as().saveDetails(
      request("PUT", {
        businessName: "A Studio",
        address: null,
        logoDataUrl: LOGO,
        defaultTemplateId: null,
      }),
    );
    const result = await preview(
      `<h1>{{freelancer.business_name}}</h1><img src="{{freelancer.logo}}"><p>{{client.name}}</p>`,
    );
    expect(result.document).toContain("<h1>A Studio</h1>");
    expect(result.document).toContain("Sam Lee");
    expect(result.document).toContain("iVBORw0KGgo");
  });

  it("shows the sanitiser's notes and saves nothing", async () => {
    const result = await preview(
      `<p onclick="x()">{{greeting}}</p><img src="https://x.example/a.png">`,
    );
    expect(result.removed).toContain("the onclick event handler");
    expect(result.refused[0]).toMatch(/remote image/);
    expect(result.document).not.toContain("x.example");
  });

  it("gives no document while a tag is unknown", async () => {
    const result = await preview("<p>{{client.phone}}</p>");
    expect(result.document).toBeNull();
    expect(result.tagIssues).toHaveLength(1);
  });
});

describe("invoice details", () => {
  const save = (body: unknown, userId = USER_A.userId) =>
    as(userId).saveDetails(request("PUT", body));

  it("saves the freelancer's business details and default template", async () => {
    const response = await save({
      businessName: "  A Studio ",
      address: "1 Test Street",
      logoDataUrl: LOGO,
      defaultTemplateId: MODERN,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      details: { businessName: "A Studio", defaultTemplateId: MODERN, logoDataUrl: LOGO },
    });
  });

  it("saves only what's sent: setting the default keeps the details, and back", async () => {
    await save({
      businessName: "A Studio",
      address: "1 Test Street",
      logoDataUrl: LOGO,
      defaultTemplateId: null,
    });
    await save({ defaultTemplateId: MODERN });
    const response = await save({
      businessName: "A Studio Ltd",
      address: "1 Test Street",
      logoDataUrl: LOGO,
    });
    expect(await json(response)).toMatchObject({
      details: { businessName: "A Studio Ltd", logoDataUrl: LOGO, defaultTemplateId: MODERN },
    });
  });

  it("refuses a remote logo, and a default the user can't see", async () => {
    const remote = await save({
      businessName: null,
      address: null,
      logoDataUrl: "https://x.example/logo.png",
      defaultTemplateId: null,
    });
    expect(remote.status).toBe(400);
    const { template } = await json<Saved>(
      await create({ name: "B's", html: "<p>x</p>" }, USER_B.userId),
    );
    const foreign = await save({
      businessName: null,
      address: null,
      logoDataUrl: null,
      defaultTemplateId: template.id,
    });
    expect(await json(foreign)).toMatchObject({
      errors: [{ field: "defaultTemplateId", message: "must be picked from the list" }],
    });
  });

  it("saves a client's company, address and default template; not another user's client", async () => {
    const body = { company: "Example Co", address: "500 Example Ave", defaultTemplateId: MODERN };
    const saved = await as().saveClientDetails(request("PUT", body), id(USER_A.rows.clients));
    expect(saved.status).toBe(200);
    const read = await as().getClientDetails(request("GET"), id(USER_A.rows.clients));
    expect(await json(read)).toEqual({ details: body });
    const foreign = await as(USER_B.userId).saveClientDetails(
      request("PUT", body),
      id(USER_A.rows.clients),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("the gallery's thumbnail", () => {
  const STUDIO = "00000000-0000-4000-8000-00000000c004";

  it("is a built-in on sample data, in a page that can load and run nothing", async () => {
    const response = await as().thumbnail(request("GET"), id(STUDIO));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("sandbox");
    const html = await response.text();
    expect(html).toContain("FPR-000042");
    expect(html).toContain("Thank you for your business");
  });

  it("shows the freelancer's own logo", async () => {
    await as().saveDetails(request("PUT", { logoDataUrl: LOGO }));
    const html = await (await as().thumbnail(request("GET"), id(STUDIO))).text();
    expect(html).toContain("iVBORw0KGgoAAAANSUhEUg");
  });

  it("is not found for another user's template", async () => {
    const saved = await json<Saved>(await create({ name: "Mine", html: "<p>{{greeting}}</p>" }));
    const response = await as(USER_B.userId).thumbnail(request("GET"), id(saved.template.id));
    expect(response.status).toBe(404);
  });

  it("is not found for something that isn't an id", async () => {
    expect((await as().thumbnail(request("GET"), id("nope"))).status).toBe(404);
  });
});

describe("the paper size and QR code settings", () => {
  beforeEach(async () => {
    await handle.db.query("UPDATE public.users SET invoice_paper = 'A4', invoice_show_qr = true");
  });

  type Details = { details: { invoicePaper: string; invoiceShowQr: boolean } };

  it("default to A4 with the QR code on", async () => {
    const { details } = await json<Details>(await as().saveDetails(request("PUT", {})));
    expect(details).toMatchObject({ invoicePaper: "A4", invoiceShowQr: true });
  });

  it("save for this user only", async () => {
    await as().saveDetails(request("PUT", { invoicePaper: "Letter", invoiceShowQr: false }));
    const mine = await json<Details>(await as().saveDetails(request("PUT", {})));
    expect(mine.details).toMatchObject({ invoicePaper: "Letter", invoiceShowQr: false });
    const theirs = await json<Details>(await as(USER_B.userId).saveDetails(request("PUT", {})));
    expect(theirs.details).toMatchObject({ invoicePaper: "A4", invoiceShowQr: true });
  });

  it("refuse a paper size that isn't A4 or Letter", async () => {
    const response = await as().saveDetails(request("PUT", { invoicePaper: "A5" }));
    expect(response.status).toBe(400);
  });
});
