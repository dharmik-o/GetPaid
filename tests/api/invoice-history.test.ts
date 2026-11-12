import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InvoiceFilters, InvoiceTable } from "@/components/InvoiceHistory";
import { runAsUser, type Db, type UserDbRunner } from "@/lib/db";
import { archiveDownloadHandler } from "@/lib/invoice-archive-handlers";
import {
  displayStatus,
  filterInvoices,
  groupByProject,
  invoicePurpose,
  listClientInvoices,
  listProjectInvoices,
  parseHistoryFilters,
  totalsByCurrency,
  type HistoryInvoice,
} from "@/lib/invoice-history";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// Invoice history: the right invoices for the right user, on real migrations and RLS.

let handle: TestDatabase;
let archiveDir: string;
const NOW = new Date("2026-12-23T15:00:00Z");
const { invoices: INVOICE_A, projects: PROJECT_A, clients: CLIENT_A } = USER_A.rows;
const { invoices: INVOICE_B, projects: PROJECT_B, clients: CLIENT_B } = USER_B.rows;
const ZONE = "America/New_York";

const runner =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);
const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, USER_A.userId, work);
const asB = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, USER_B.userId, work);

/** The archive table can't be changed by its owner, so tests set it up from outside RLS. */
const addFile = (
  invoiceId: string,
  userId: string,
  version: number,
  relativePath: string,
  sentAt: string | null = "2026-12-01T10:00:00Z",
) =>
  handle.db.query(
    `INSERT INTO public.invoice_archive_files
       (user_id, invoice_id, version, relative_path, sha256, template_name, signed, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'Studio', true, $6)`,
    [userId, invoiceId, version, relativePath, "a".repeat(64), sentAt],
  );

const clearFiles = async () => {
  await handle.db.query("ALTER TABLE public.invoice_archive_files DISABLE ROW LEVEL SECURITY");
  await handle.db.query("DELETE FROM public.invoice_archive_files");
  await handle.db.query("ALTER TABLE public.invoice_archive_files ENABLE ROW LEVEL SECURITY");
};

const download = (id: string, version: string, userId: string = USER_A.userId) =>
  archiveDownloadHandler(() => ({ runAsUser: runner(userId), dir: archiveDir })).get(
    new Request("http://127.0.0.1:3000/api/x"),
    { params: Promise.resolve({ id, version }) },
  );

const fake = (overrides: Partial<HistoryInvoice>): HistoryInvoice => ({
  id: "i1",
  number: "FPR-1",
  purpose: "Design",
  status: "sent",
  amountCents: 10_000,
  amountPaidCents: 0,
  currency: "USD",
  link: "https://www.sandbox.paypal.com/invoice/p/#x",
  projectId: "p1",
  projectTitle: "Website",
  sentAt: "2026-12-01T10:00:00.000Z",
  day: "2026-12-01",
  templateName: "Classic",
  paymentMethod: null,
  closable: false,
  signed: false,
  versions: [],
  ...overrides,
});

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  archiveDir = await mkdtemp(join(tmpdir(), "fpr-history-"));
  await clearFiles();
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent', amount_paid_cents = 0, due_date = '2027-01-30',
       invoice_number = CASE id WHEN '${INVOICE_A}'::uuid THEN 'FPR-AAA' ELSE 'FPR-BBB' END,
       link = 'https://www.sandbox.paypal.com/invoice/p/#x', template_id = NULL`,
  );
});

afterEach(async () => {
  await rm(archiveDir, { recursive: true, force: true });
});

describe("who sees what", () => {
  it("lists a project's invoices for its owner", async () => {
    const list = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
    expect(list.map((invoice) => invoice.number)).toEqual(["FPR-AAA"]);
  });

  it("lists a client's invoices for their owner", async () => {
    const list = await asA((db) => listClientInvoices(db, CLIENT_A, NOW));
    expect(list.map((invoice) => invoice.number)).toEqual(["FPR-AAA"]);
  });

  it("shows nothing of another user's project", async () => {
    expect(await asA((db) => listProjectInvoices(db, PROJECT_B, NOW))).toEqual([]);
    expect(await asB((db) => listProjectInvoices(db, PROJECT_A, NOW))).toEqual([]);
  });

  it("shows nothing of another user's client", async () => {
    expect(await asA((db) => listClientInvoices(db, CLIENT_B, NOW))).toEqual([]);
    expect(await asB((db) => listClientInvoices(db, CLIENT_A, NOW))).toEqual([]);
  });

  it("doesn't list another project's invoices", async () => {
    const other = "aaaaaaaa-0000-4000-8000-00000000f001";
    await handle.db.query(
      `INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency)
       VALUES ('${other}', '${USER_A.userId}', '${CLIENT_A}', 'Another', 1000, 'USD')
       ON CONFLICT DO NOTHING`,
    );
    expect(await asA((db) => listProjectInvoices(db, other, NOW))).toEqual([]);
  });
});

describe("an invoice's versions", () => {
  it("come newest first, each with what it was", async () => {
    await addFile(INVOICE_A, USER_A.userId, 1, "Client a/Website redesign/FPR-AAA.pdf");
    await addFile(INVOICE_A, USER_A.userId, 2, "Client a/Website redesign/FPR-AAA (v2).pdf");
    const [invoice] = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
    expect(invoice?.versions.map((file) => file.version)).toEqual([2, 1]);
    expect(invoice?.versions[0]).toMatchObject({ templateName: "Studio", signed: true });
  });

  it("are empty until a PDF is saved", async () => {
    const [invoice] = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
    expect(invoice?.versions).toEqual([]);
  });
});

describe("what it's for", () => {
  const base = {
    milestoneName: null,
    retainerName: null,
    maintenanceTask: null,
    installment: null,
    retainerCycleOn: null,
  };

  it.each([
    ["a milestone", { milestoneName: "Design" }, "Design"],
    [
      "an installment",
      { milestoneName: "Build", installment: { number: 2, count: 3 } },
      "Build, installment 2 of 3",
    ],
    [
      "a retainer cycle",
      { retainerName: "Care plan", retainerCycleOn: "2026-12-16" },
      "Retainer: Care plan, charge of 16 Dec 2026",
    ],
    [
      "maintenance",
      { milestoneName: "Job", maintenanceTask: "Security updates" },
      "Maintenance: Security updates",
    ],
  ])("names %s", (_what, row, expected) => {
    expect(invoicePurpose({ ...base, ...row })).toBe(expected);
  });

  it("reads a retainer's invoice on the project it belongs to", async () => {
    const id = "aaaaaaaa-0000-4000-8000-00000000f002";
    await handle.db.query(
      `INSERT INTO public.invoices (id, user_id, retainer_id, amount_cents, currency, due_date, retainer_cycle_on)
       VALUES ('${id}', '${USER_A.userId}', '${USER_A.rows.retainers}', 20000, 'USD', '2027-01-30', '2026-12-16')`,
    );
    try {
      const list = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
      expect(list.find((invoice) => invoice.id === id)?.purpose).toBe(
        "Retainer: Monthly maintenance, charge of 16 Dec 2026",
      );
    } finally {
      await handle.db.query(`DELETE FROM public.invoices WHERE id = '${id}'`);
    }
  });

  it("names a maintenance job's invoice by its job", async () => {
    await handle.db.query(
      `UPDATE public.maintenance_tasks SET job_project_id = '${PROJECT_A}' WHERE id = '${USER_A.rows.maintenance_tasks}'`,
    );
    try {
      const [invoice] = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
      expect(invoice?.purpose).toContain("Maintenance: Security updates");
    } finally {
      await handle.db.query(
        `UPDATE public.maintenance_tasks SET job_project_id = NULL WHERE id = '${USER_A.rows.maintenance_tasks}'`,
      );
    }
  });
});

describe("its status", () => {
  it.each([
    ["sent", "2027-01-01", "sent"],
    ["sent", "2026-12-01", "overdue"],
    ["partially_paid", "2026-12-01", "overdue"],
    ["partially_paid", "2027-01-01", "partially_paid"],
    ["paid", "2026-12-01", "paid"],
    ["draft", "2026-12-01", "draft"],
    ["cancelled", "2026-12-01", "cancelled"],
    ["refunded", "2026-12-01", "refunded"],
    ["disputed", "2026-12-01", "disputed"],
  ])("%s, due %s, shows as %s", (status, due, expected) => {
    expect(displayStatus(status, due, "2026-12-23")).toBe(expected);
  });

  it("isn't overdue on its due day", () => {
    expect(displayStatus("sent", "2026-12-23", "2026-12-23")).toBe("sent");
  });

  it("works out overdue in the client's time zone, from the database", async () => {
    await handle.db.query(
      `UPDATE public.invoices SET due_date = '2026-12-22' WHERE id = '${INVOICE_A}'`,
    );
    const late = await asA((db) => listProjectInvoices(db, PROJECT_A, NOW));
    expect(late[0]?.status).toBe("overdue");
    // 02:00 UTC on the 23rd is still the 22nd in New York: its due day, so not yet overdue.
    const early = await asA((db) =>
      listProjectInvoices(db, PROJECT_A, new Date("2026-12-23T02:00:00Z")),
    );
    expect(early[0]?.status).toBe("sent");
  });
});

describe("filters", () => {
  const invoices = [
    fake({ id: "a", status: "paid", day: "2026-11-01" }),
    fake({ id: "b", status: "sent", day: "2026-12-01" }),
    fake({ id: "c", status: "overdue", day: "2026-12-15" }),
  ];
  const ids = (status: string | null, from: string | null, to: string | null) =>
    filterInvoices(invoices, parseHistoryFilters({ status, from, to })).map((row) => row.id);

  it("by status", () => {
    expect(ids("paid", null, null)).toEqual(["a"]);
    expect(ids("overdue", null, null)).toEqual(["c"]);
  });

  it("by date range, including both ends", () => {
    expect(ids(null, "2026-12-01", null)).toEqual(["b", "c"]);
    expect(ids(null, null, "2026-12-01")).toEqual(["a", "b"]);
    expect(ids(null, "2026-12-01", "2026-12-01")).toEqual(["b"]);
  });

  it("by both together", () => {
    expect(ids("sent", "2026-12-01", "2026-12-31")).toEqual(["b"]);
    expect(ids("paid", "2026-12-01", "2026-12-31")).toEqual([]);
  });

  it("ignores values typed into the address that aren't real", () => {
    expect(parseHistoryFilters({ status: "drop table", from: "soon", to: ["x"] })).toEqual({
      status: null,
      from: null,
      to: null,
    });
  });
});

describe("totals", () => {
  it("keep each currency apart, and never convert", () => {
    expect(
      totalsByCurrency([
        fake({ currency: "USD", amountCents: 10_000, amountPaidCents: 2_500 }),
        fake({ currency: "EUR", amountCents: 5_000, amountPaidCents: 5_000, status: "paid" }),
        fake({ currency: "USD", amountCents: 1_000, amountPaidCents: 0 }),
      ]),
    ).toEqual([
      { currency: "EUR", sentCents: 5_000, paidCents: 5_000 },
      { currency: "USD", sentCents: 11_000, paidCents: 2_500 },
    ]);
  });

  it("don't count a draft or a cancelled invoice as sent", () => {
    expect(
      totalsByCurrency([
        fake({ status: "draft", amountCents: 1_000 }),
        fake({ status: "cancelled", amountCents: 2_000 }),
        fake({ status: "overdue", amountCents: 4_000 }),
      ]),
    ).toEqual([{ currency: "USD", sentCents: 4_000, paidCents: 0 }]);
  });

  it("count an invoice once, however many versions it has", () => {
    const versions = [1, 2, 3].map((version) => ({
      version,
      sentAt: null,
      templateName: null,
      signed: false,
    }));
    expect(totalsByCurrency([fake({ amountCents: 1_000, versions })])[0]?.sentCents).toBe(1_000);
  });
});

describe("grouping by project", () => {
  it("groups, and gives a retainer with no project its own group", () => {
    const groups = groupByProject([
      fake({ id: "a", projectId: "p1", projectTitle: "Website" }),
      fake({ id: "b", projectId: null, projectTitle: null }),
      fake({ id: "c", projectId: "p1", projectTitle: "Website" }),
    ]);
    expect(groups.map((group) => [group.title, group.invoices.map((row) => row.id)])).toEqual([
      ["Website", ["a", "c"]],
      ["No project", ["b"]],
    ]);
  });
});

describe("the table", () => {
  const render = (invoices: HistoryInvoice[]) =>
    renderToStaticMarkup(createElement(InvoiceTable, { invoices, zone: ZONE }));

  it("shows one row per version, newest first, with its own download", () => {
    const html = render([
      fake({
        versions: [
          { version: 2, sentAt: "2026-12-20T10:00:00Z", templateName: "Noir", signed: true },
          { version: 1, sentAt: "2026-12-01T10:00:00Z", templateName: "Classic", signed: false },
        ],
      }),
    ]);
    expect(html.indexOf("/versions/2")).toBeLessThan(html.indexOf("/versions/1"));
    expect(html).toContain("Noir");
    expect(html).toContain("Classic");
    expect(html).toContain("20 Dec");
    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
  });

  it("has every column you asked for", () => {
    const html = render([fake({})]);
    for (const column of [
      "Invoice",
      "For",
      "Sent",
      "Amount",
      "Status",
      "Theme",
      "Signed",
      "Actions",
    ]) {
      expect(html).toContain(`>${column}<`);
    }
    expect(html).toContain("USD");
    expect(html).toContain("Open PayPal invoice");
    expect(html).toContain("Download PDF");
  });

  it.each([
    ["paid", "Paid", "badge-paid"],
    ["overdue", "Overdue", "badge-overdue"],
    ["draft", "Draft", "badge-draft"],
    ["cancelled", "Cancelled", "badge-draft"],
    ["refunded", "Refunded", "badge-draft"],
    ["sent", "Sent", "badge-sent"],
  ] as const)("shows %s with its label and badge", (status, label, badge) => {
    const html = render([fake({ status })]);
    expect(html).toContain(badge);
    expect(html).toContain(`>${label}<`);
  });

  it("says when it hasn't been sent, and offers the working copy", () => {
    const html = render([fake({ sentAt: null })]);
    expect(html).toContain("Not sent");
    expect(html).toContain("/api/invoices/i1/pdf");
  });

  it("offers nothing to pay on a cancelled invoice", () => {
    const html = render([fake({ status: "cancelled" })]);
    expect(html).not.toContain("Open PayPal invoice");
    expect(html).not.toContain("Download PDF");
  });

  it("still offers a cancelled invoice's saved copy, as it's the record of what was sent", () => {
    const html = render([
      fake({
        status: "cancelled",
        versions: [{ version: 1, sentAt: null, templateName: null, signed: false }],
      }),
    ]);
    expect(html).toContain("/versions/1");
  });

  it("escapes what a client or project was called", () => {
    expect(render([fake({ purpose: "<script>alert(1)</script>" })])).not.toContain("<script>");
  });
});

describe("the filter form", () => {
  const html = renderToStaticMarkup(
    createElement(InvoiceFilters, {
      filters: { status: "paid", from: "2026-11-01", to: null },
      action: "#invoices",
      hidden: { tab: "invoices" },
    }),
  );

  it("is a plain form that works without scripts, and keeps the tab", () => {
    expect(html).toContain('method="get"');
    expect(html).toContain('name="tab" value="invoices"');
  });

  it("offers every status, with labels on every field", () => {
    for (const label of ["Draft", "Sent", "Paid", "Overdue", "Cancelled", "Refunded"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('for="history-status"');
    expect(html).toContain('for="history-from"');
    expect(html).toContain('for="history-to"');
  });

  it("shows what's chosen", () => {
    expect(html).toContain('value="2026-11-01"');
  });
});

describe("downloading a saved PDF", () => {
  const PATH = "Client a/Website redesign/FPR-AAA (v2).pdf";

  const place = async (relative: string, contents = "%PDF saved") => {
    const file = join(archiveDir, ...relative.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  };

  it("serves the file to its owner", async () => {
    await place(PATH);
    await addFile(INVOICE_A, USER_A.userId, 2, PATH);
    const response = await download(INVOICE_A, "2");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF saved");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="FPR-AAA (v2).pdf"',
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is not found for another user, even with the right ids", async () => {
    await place(PATH);
    await addFile(INVOICE_A, USER_A.userId, 2, PATH);
    expect((await download(INVOICE_A, "2", USER_B.userId)).status).toBe(404);
  });

  it.each([
    "../secret.pdf",
    "../../secret.pdf",
    "Client/../../secret.pdf",
    "..\\secret.pdf",
    "C:\\secret.pdf",
    "/secret.pdf",
  ])("won't read outside the folder if a row says %s", async (path) => {
    await writeFile(join(archiveDir, "..", "secret.pdf"), "secret").catch(() => undefined);
    await addFile(INVOICE_A, USER_A.userId, 1, path);
    const response = await download(INVOICE_A, "1");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("is not found when the file has gone", async () => {
    await addFile(INVOICE_A, USER_A.userId, 1, "Client a/gone.pdf");
    expect((await download(INVOICE_A, "1")).status).toBe(404);
  });

  it.each(["0", "-1", "1.5", "abc", "1; DROP TABLE", "999999999"])(
    "is not found for the version %s",
    async (version) => {
      expect((await download(INVOICE_A, version)).status).toBe(404);
    },
  );

  it("is not found for something that isn't an invoice id", async () => {
    expect((await download("nope", "1")).status).toBe(404);
  });

  it("makes a quote or line break in a name harmless in the header", async () => {
    const hostile = 'Client a/x/FPR"\r\nX-Evil: 1.pdf';
    await place("Client a/x/FPR.pdf");
    await addFile(INVOICE_A, USER_A.userId, 1, hostile);
    const response = await download(INVOICE_A, "1");
    expect(response.headers.get("x-evil")).toBeNull();
  });
});

describe("the demo project's seeded ids", () => {
  it("keep user B's invoice for user B", async () => {
    const list = await asB((db) => listProjectInvoices(db, PROJECT_B, NOW));
    expect(list.map((invoice) => invoice.id)).toEqual([INVOICE_B]);
  });
});
