import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IncludeSignature, startsTicked } from "@/components/IncludeSignature";
import { InvoiceDetailsForm } from "@/components/InvoiceDetailsForm";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { invoicePdf } from "@/lib/invoice-pdfs";
import { createPaypalClient } from "@/lib/paypal";
import { insertCycleInvoice, loadCycleRow } from "@/lib/retainer-invoices";
import { createRetainer } from "@/lib/retainers";
import { templateHandlers } from "@/lib/template-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal } from "../mocks/paypal";

// The signature: saved in Settings, then on or off per invoice, end to end on real migrations and
// RLS. PayPal is mocked (msw), and Chromium is a recorder here (tests/invoice-signature.test.ts
// draws with the real one).

vi.mock("../../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

let handle: TestDatabase;
let dir: string;
let rendered: string[] = [];
const server = setupServer();
const NOW = new Date("2026-11-03T15:00:00Z");
const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000000b2";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const DRAWN = "data:image/png;base64,iVBORw0KGgoDRAWN";
const SIGNATURE_ALT = 'alt="Signature"';

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const as = (userId = USER_A.userId, renderSignature = () => Promise.resolve(DRAWN)) =>
  templateHandlers({ runAsUser: runnerFor(userId), renderSignature });

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const pdfDeps = () => ({
  runAsUser: runnerFor(USER_A.userId),
  renderPdf: (html: string) => {
    rendered.push(html);
    return Promise.resolve(Buffer.from(`%PDF-1.7 fake ${String(rendered.length)}`));
  },
  dir,
  archiveDir: dir,
});

const issue = (body: unknown = {}) =>
  invoiceHandlers({
    runAsUser: runnerFor(USER_A.userId),
    paypal: () => createPaypalClient({ clientId: "id", clientSecret: "secret" }),
    now: () => NOW,
    pdf: (invoiceId) => invoicePdf(pdfDeps(), invoiceId),
  }).issue(request("POST", body), { params: Promise.resolve({ id: BUILD }) });

type Issued = { invoices: { id: string; includeSignature: boolean }[] };

const saveSignature = (overrides: object = {}) =>
  as().saveDetails(
    request("PUT", {
      signatureSource: "upload",
      signatureImageDataUrl: PNG,
      signatureName: "Alex Rivera",
      signatureTitle: "Founder",
      ...overrides,
    }),
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  rendered = [];
  dir = await mkdtemp(join(tmpdir(), "fpr-signature-"));
  server.resetHandlers(
    ...createFakePaypal().handlers,
    http.get("*/never", () => HttpResponse.json({})),
  );
  await handle.db.query(`UPDATE public.users SET signature_source = NULL,
    signature_image_data_url = NULL, signature_typed_name = NULL, signature_name = NULL,
    signature_title = NULL, signature_default = false`);
  await handle.db.query(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
  await handle.db.query(`
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Website v2', 300000, 'USD', '2026-12-31');
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

describe("saving a signature", () => {
  type Saved = {
    details: { signatureSource: string | null; signatureImageDataUrl: string | null };
  };

  it("keeps an uploaded image, with the signer's name and title", async () => {
    const { details } = await json<Saved>(await saveSignature());
    expect(details).toMatchObject({
      signatureSource: "upload",
      signatureImageDataUrl: PNG,
      signatureName: "Alex Rivera",
      signatureTitle: "Founder",
    });
  });

  it("draws a typed name on the server", async () => {
    const response = await as().saveDetails(
      request("PUT", { signatureSource: "typed", signatureTypedName: "Alex Rivera" }),
    );
    expect((await json<Saved>(response)).details.signatureImageDataUrl).toBe(DRAWN);
  });

  it("ignores an image sent with a typed name: it's always the server's drawing", async () => {
    const response = await as().saveDetails(
      request("PUT", {
        signatureSource: "typed",
        signatureTypedName: "Alex Rivera",
        signatureImageDataUrl: PNG,
      }),
    );
    expect((await json<Saved>(response)).details.signatureImageDataUrl).toBe(DRAWN);
  });

  it("doesn't draw again when the typed name hasn't changed", async () => {
    let draws = 0;
    const counted = () => {
      draws += 1;
      return Promise.resolve(DRAWN);
    };
    const body = { signatureSource: "typed", signatureTypedName: "Alex Rivera" };
    await as(USER_A.userId, counted).saveDetails(request("PUT", body));
    await as(USER_A.userId, counted).saveDetails(request("PUT", body));
    expect(draws).toBe(1);
  });

  it("says so when the name can't be drawn", async () => {
    const broken = () => Promise.reject(new Error("no browser"));
    const response = await as(USER_A.userId, broken).saveDetails(
      request("PUT", { signatureSource: "typed", signatureTypedName: "Alex Rivera" }),
    );
    expect(response.status).toBe(503);
    expect((await json<{ error: string }>(response)).error).toContain("Upload an image instead");
  });

  it.each([
    ["an SVG", { signatureImageDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
    ["no image at all", { signatureImageDataUrl: null }],
    [
      "a file bigger than 500 KB",
      { signatureImageDataUrl: `data:image/png;base64,${"A".repeat(800_000)}` },
    ],
  ])("refuses %s", async (_what, overrides) => {
    expect((await saveSignature(overrides)).status).toBe(400);
  });

  it("refuses a typed signature with no name", async () => {
    const response = await as().saveDetails(
      request("PUT", { signatureSource: "typed", signatureTypedName: "" }),
    );
    expect(response.status).toBe(400);
  });

  it("removes everything about it when turned off", async () => {
    await saveSignature();
    const { details } = await json<Saved>(
      await as().saveDetails(request("PUT", { signatureSource: null })),
    );
    expect(details).toMatchObject({
      signatureSource: null,
      signatureImageDataUrl: null,
      signatureName: null,
      signatureTitle: null,
    });
  });

  it("is one user's: another user's account doesn't change", async () => {
    await saveSignature();
    const { details } = await json<Saved>(await as(USER_B.userId).saveDetails(request("PUT", {})));
    expect(details.signatureImageDataUrl).toBeNull();
  });

  it("never logs the image", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await saveSignature();
      await saveSignature({ signatureImageDataUrl: "data:image/svg+xml;base64,U0VDUkVU" });
      const everything = JSON.stringify([
        ...write.mock.calls,
        ...error.mock.calls,
        ...log.mock.calls,
      ]);
      expect(everything).not.toContain("iVBORw0KGgo");
      expect(everything).not.toContain("U0VDUkVU");
    } finally {
      write.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});

describe("a signature on an invoice", () => {
  const stored = async (id: string) =>
    (
      await handle.db.query<{ include_signature: boolean }>(
        "SELECT include_signature FROM public.invoices WHERE id = $1",
        [id],
      )
    ).rows[0]?.include_signature;

  const makeInvoice = async (body: unknown) => {
    const { invoices } = await json<Issued>(await issue(body));
    const invoice = invoices[0];
    if (!invoice) throw new Error("No invoice came back.");
    return invoice;
  };

  it("shows when it's ticked for this invoice", async () => {
    await saveSignature();
    const invoice = await makeInvoice({ includeSignature: true });
    expect(await stored(invoice.id)).toBe(true);
    expect(rendered.at(-1)).toContain(SIGNATURE_ALT);
    expect(rendered.at(-1)).toContain("Founder");
  });

  it("stays off when it's unticked, even with the default on", async () => {
    await saveSignature({ signatureDefault: true });
    const invoice = await makeInvoice({ includeSignature: false });
    expect(await stored(invoice.id)).toBe(false);
    expect(rendered.at(-1)).not.toContain(SIGNATURE_ALT);
  });

  it("follows the default when a request doesn't say", async () => {
    await saveSignature({ signatureDefault: true });
    expect(await stored((await makeInvoice({})).id)).toBe(true);
  });

  it("is off by default", async () => {
    await saveSignature();
    expect(await stored((await makeInvoice({})).id)).toBe(false);
    expect(rendered.at(-1)).not.toContain(SIGNATURE_ALT);
  });

  it("shows nothing when ticked but none is set up", async () => {
    const invoice = await makeInvoice({ includeSignature: true });
    expect(await stored(invoice.id)).toBe(true);
    expect(rendered.at(-1)).not.toContain(SIGNATURE_ALT);
  });

  it("is refused if it isn't true or false", async () => {
    expect((await issue({ includeSignature: "yes" })).status).toBe(400);
  });

  it("applies to every installment of a plan", async () => {
    await saveSignature();
    await handle.db.query(`
      INSERT INTO public.installment_plans (user_id, milestone_id, count, total_cents, currency, items, created_from)
      VALUES ('${USER_A.userId}', '${BUILD}', 2, 300000, 'USD',
        '[{"amountCents":150000,"dueDate":"2026-11-20"},{"amountCents":150000,"dueDate":"2026-12-20"}]', 'setup')`);
    const { invoices } = await json<Issued>(await issue({ includeSignature: true }));
    expect(invoices).toHaveLength(2);
    for (const invoice of invoices) expect(await stored(invoice.id)).toBe(true);
  });
});

describe("a retainer's invoices", () => {
  const retainerBody = (overrides: object) => ({
    clientId: USER_A.rows.clients,
    name: "Care plan",
    amountCents: 20000,
    currency: "USD",
    unit: "month",
    count: 1,
    startsOn: "2026-11-20",
    method: "invoice",
    ...overrides,
  });

  const create = (overrides: object) =>
    runAsUser(handle.db, USER_A.userId, async (db) => {
      const result = await createRetainer(db, retainerBody(overrides), NOW);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.id;
    });

  const cycleSigned = (id: string) =>
    runAsUser(handle.db, USER_A.userId, async (db) => {
      const row = await loadCycleRow(db, id);
      if (!row) throw new Error("No retainer.");
      await insertCycleInvoice(db, id, row, {
        on: "2026-11-20",
        dueDate: "2026-11-27",
        reason: "cycle",
      });
      const { rows } = await db.query<{ include_signature: boolean }>(
        "SELECT include_signature FROM public.invoices WHERE retainer_id = $1",
        [id],
      );
      return rows[0]?.include_signature;
    });

  it("copy the retainer's choice when it's on", async () => {
    expect(await cycleSigned(await create({ includeSignature: true }))).toBe(true);
  });

  it("copy the retainer's choice when it's off", async () => {
    await saveSignature({ signatureDefault: true });
    expect(await cycleSigned(await create({ includeSignature: false }))).toBe(false);
  });

  it("start from the account's default when nothing is chosen", async () => {
    await saveSignature({ signatureDefault: true });
    expect(await cycleSigned(await create({}))).toBe(true);
  });
});

describe("the checkbox", () => {
  const render = (props: Parameters<typeof IncludeSignature>[0]) =>
    renderToStaticMarkup(createElement(IncludeSignature, props));
  const noop = () => undefined;

  it("is labelled, and ticked when chosen", () => {
    const html = render({ available: true, checked: true, onChange: noop });
    expect(html).toContain("Include my signature");
    expect(html).toContain('checked=""');
  });

  it("is off and disabled with no signature, and says where to add one", () => {
    const html = render({ available: false, checked: true, onChange: noop });
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('checked=""');
    expect(html).toContain("Settings &gt; Invoice templates");
  });

  it.each([
    [{ available: true, byDefault: true }, true],
    [{ available: true, byDefault: false }, false],
    [{ available: false, byDefault: true }, false],
  ])("starts from the default: %j", (choice, expected) => {
    expect(startsTicked(choice)).toBe(expected);
  });
});

describe("the setting", () => {
  const initial = {
    businessName: null,
    address: null,
    logoDataUrl: null,
    invoicePaper: "A4" as const,
    invoiceShowQr: true,
    signatureSource: "upload" as const,
    signatureImageDataUrl: PNG,
    signatureTypedName: null,
    signatureName: null,
    signatureTitle: null,
    signatureDefault: false,
  };

  const html = renderToStaticMarkup(createElement(InvoiceDetailsForm, { initial, name: "Alex" }));

  it("says once that it isn't a legal e-signature", () => {
    const note = "This adds a picture of your signature. It isn&#x27;t a legal e-signature.";
    expect(html.split(note)).toHaveLength(2);
  });

  it("offers PNG and JPG only", () => {
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).not.toContain("svg+xml");
  });

  it("offers a default for new invoices", () => {
    expect(html).toContain("Include my signature on new invoices");
  });
});
