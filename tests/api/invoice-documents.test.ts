import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { invoicePdfHandler, invoiceTextHandler } from "@/lib/invoice-document-handlers";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { invoicePdf } from "@/lib/invoice-pdfs";
import { createPaypalClient } from "@/lib/paypal";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";

// Invoice documents end to end: the template and text picked on Create invoice, the PDF made
// after sending, the download, and the AI-written text. PayPal and the model are mocked (msw);
// Chromium is replaced by a recorder here (tests/invoice-pdf.test.ts runs the real one).

let handle: TestDatabase;
let fake: FakePaypal;
let dir: string;
let rendered: string[] = [];
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const NOW = new Date("2026-11-03T15:00:00Z");
const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000000b2";
const MODERN = "00000000-0000-4000-8000-00000000c002";
const MINIMAL = "00000000-0000-4000-8000-00000000c003";
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const fakeRender = (html: string) => {
  rendered.push(html);
  return Promise.resolve(Buffer.from(`%PDF-1.7 fake ${String(rendered.length)}`));
};
const pdfDeps = (userId = USER_A.userId) => ({
  runAsUser: runnerFor(userId),
  renderPdf: fakeRender,
  dir,
});

const issue = (
  body: unknown = {},
  pdf?: (id: string) => Promise<unknown>,
) =>
  invoiceHandlers({
    runAsUser: runnerFor(USER_A.userId),
    paypal: () => createPaypalClient({ clientId: "id", clientSecret: "secret" }),
    now: () => NOW,
    pdf: pdf ?? ((invoiceId) => invoicePdf(pdfDeps(), invoiceId)),
  }).issue(
    new Request("http://127.0.0.1:3000/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: BUILD }) },
  );

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
type Issued = { invoices: { id: string; link: string; invoiceNumber: string }[] };

const invoiceRow = async (id: string) =>
  (
    await handle.db.query<{ template_id: string; pdf_path: string | null; invoice_text: unknown }>(
      "SELECT template_id::text, pdf_path, invoice_text FROM public.invoices WHERE id = $1",
      [id],
    )
  ).rows[0];

const TEXT = {
  greeting: "Hello Client a,",
  thank_you_note: "Thank you for the work together.",
  project_summary: "This covers the build of the new website.",
  notes: "",
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await runAsUser(handle.db, USER_A.userId, (db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: null,
      },
      box,
    ),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  rendered = [];
  dir = await mkdtemp(join(tmpdir(), "fpr-pdfs-"));
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  await handle.db.query("UPDATE public.users SET default_template_id = NULL");
  await handle.db.query("UPDATE public.clients SET default_template_id = NULL");
  await handle.db.query(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
  await handle.db.query(`
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline, late_fee_clause)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Website v2', 300000, 'USD', '2026-12-31', '1.5% per month on late invoices.');
    INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, deliverable, percent_bp, deadline, payment_mode, status)
      VALUES ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'Build', 'the new website', 10000, '2026-12-10', 'pay_on_invoice', 'delivered');
  `);
});

afterEach(async () => {
  server.resetHandlers();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("Create invoice with a template and text", () => {
  it("fills the picked template from the database and stores the PDF", async () => {
    const response = await issue({ templateId: MINIMAL, text: TEXT });
    expect(response.status).toBe(201);
    const [invoice] = (await json<Issued>(response)).invoices;
    if (!invoice) throw new Error("no invoice");
    const row = await invoiceRow(invoice.id);
    expect(row).toMatchObject({ template_id: MINIMAL, invoice_text: TEXT });
    expect(row?.pdf_path).toBe(`${USER_A.userId}/${invoice.id}.pdf`);
    const html = rendered[0] ?? "";
    for (const value of [
      invoice.invoiceNumber,
      "Client a",
      "Hello Client a,",
      "Website v2: Build",
      "Net 14",
      "17 Nov 2026",
      "1.5% per month on late invoices.",
    ]) {
      expect(html).toContain(value);
    }
    // The pay link comes from PayPal (Mustache escapes its "/", not the invoice id after "#").
    expect(html).toContain(`#${invoice.link.split("#")[1] ?? "missing"}`);
    const stored = await readFile(join(dir, row?.pdf_path ?? ""));
    expect(stored.toString()).toBe("%PDF-1.7 fake 1");
  });

  it("uses the client's default, else the account's, else Classic", async () => {
    await handle.db.query("UPDATE public.users SET default_template_id = $1 WHERE id = $2", [
      MODERN,
      USER_A.userId,
    ]);
    await handle.db.query("UPDATE public.clients SET default_template_id = $1 WHERE id = $2", [
      MINIMAL,
      USER_A.rows.clients,
    ]);
    const [invoice] = (await json<Issued>(await issue())).invoices;
    expect((await invoiceRow(invoice?.id ?? ""))?.template_id).toBe(MINIMAL);
  });

  it("falls back to the fixed text when none is given", async () => {
    const [invoice] = (await json<Issued>(await issue())).invoices;
    expect((await invoiceRow(invoice?.id ?? ""))?.invoice_text).toMatchObject({
      greeting: "Hello Client a,",
      project_summary: "This invoice covers Build for Website v2: the new website.",
    });
  });

  it("refuses text with an amount or a date, before anything reaches PayPal", async () => {
    const response = await issue({ text: { ...TEXT, notes: "Please pay USD 1,500 by Friday." } });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      errors: [
        { field: "text.notes", message: expect.stringMatching(/amount or a date/) as string },
      ],
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a template the user can't see", async () => {
    const { rows } = await handle.db.query<{ id: string }>(
      `INSERT INTO public.invoice_templates (user_id, name, kind, html) VALUES ('${USER_B.userId}', 'B', 'custom', '<p>x</p>') RETURNING id::text`,
    );
    const response = await issue({ templateId: rows[0]?.id });
    expect(await json(response)).toMatchObject({ errors: [{ field: "templateId" }] });
  });

  it("a PDF failure never undoes the sent invoice", async () => {
    const response = await issue({}, () => Promise.reject(new Error("Chromium crashed")));
    expect(response.status).toBe(201);
    const [invoice] = (await json<Issued>(response)).invoices;
    expect((await invoiceRow(invoice?.id ?? ""))?.pdf_path).toBeNull();
  });
});

describe("GET /api/invoices/[id]/pdf", () => {
  const download = (id: string, userId = USER_A.userId) =>
    invoicePdfHandler(() => pdfDeps(userId)).get(
      new Request("http://127.0.0.1:3000/api/x"),
      context(id),
    );

  it("serves the stored PDF as a download, made once", async () => {
    const [invoice] = (await json<Issued>(await issue())).invoices;
    const response = await download(invoice?.id ?? "");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(
      /attachment; filename="invoice-FPR-\d+\.pdf"/,
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-1.7 fake 1");
    expect(rendered).toHaveLength(1);
  });

  it("makes the PDF again if the file is gone", async () => {
    const [invoice] = (await json<Issued>(await issue({}, () => Promise.resolve()))).invoices;
    const response = await download(invoice?.id ?? "");
    expect(response.status).toBe(200);
    expect(rendered).toHaveLength(1);
    expect((await invoiceRow(invoice?.id ?? ""))?.pdf_path).not.toBeNull();
  });

  it("another user's invoice is not found (RLS)", async () => {
    const [invoice] = (await json<Issued>(await issue())).invoices;
    expect((await download(invoice?.id ?? "", USER_B.userId)).status).toBe(404);
  });
});

describe("POST /api/milestones/[id]/invoice-text", () => {
  const draftText = () =>
    invoiceTextHandler({ runAsUser: runnerFor(USER_A.userId), box: () => box }).post(
      new Request("http://127.0.0.1:3000/api/x", { method: "POST" }),
      context(BUILD),
    );
  const model = (reply: object) => {
    let calls = 0;
    server.use(
      http.post(LOCAL_URL, () => {
        calls += 1;
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
      }),
    );
    return () => calls;
  };

  it("returns the model's text when it passes the checks", async () => {
    model(TEXT);
    expect(await json(await draftText())).toEqual({ text: TEXT, via: "model" });
  });

  it("rejects AI text with an amount or a date: one retry, then the fixed text", async () => {
    const calls = model({ ...TEXT, notes: "The total is USD 1,500, due 17 November." });
    const result = await json<{ text: typeof TEXT; via: string }>(await draftText());
    expect(calls()).toBe(2);
    expect(result.via).toBe("template");
    expect(result.text.notes).toBe("");
  });
});
