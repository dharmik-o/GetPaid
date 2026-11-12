import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Mustache from "mustache";
import { PDFDocument } from "pdf-lib";
import {
  archiveDirProblem,
  demandsDirRelative,
  lawyerPackRelativePath,
  resolveInsideArchive,
} from "./archive-paths";
import { getClient } from "./clients";
import type { Db, UserDbRunner } from "./db";
import { toCents, toIso } from "./db-values";
import { lawClaim } from "./final-demand";
import { formatFullDay, formatMoney } from "./format";
import { getClientDetails } from "./invoice-details";
import { methodLabel } from "./invoice-closing";
import type { Law } from "./legal";
import { getProject } from "./projects";
import type { ReferenceRates } from "./reference-rates";
import { todayIn } from "./schedule";
import { documentFontCss } from "./document-fonts";
import { DOCUMENT_CSP } from "./template-render";

// Server-only: the "lawyer pack", one PDF a freelancer can hand to a lawyer: a cover (parties, project,
// amounts, the statutory calculation, a table of contents), the signed agreement, every invoice, a
// timeline of everything sent and received, and every final demand. It is made as the signed-in user
// (RLS), so only that user's project is found, and files are read only from inside the archive folder.
// Nothing secret goes in: no API keys, signing tokens, calendar addresses or other clients' data.

export const PAGE_LIMIT = 200;

export type PackDeps = {
  runAsUser: UserDbRunner;
  /** Chromium in the app, a fake in tests. */
  renderPdf: (html: string) => Promise<Buffer>;
  archiveDir: string;
  now: () => Date;
  laws: readonly Law[];
  rates: ReferenceRates;
};

export type PackResult =
  | { ok: true; relativePath: string; bytes: Buffer; pages: number; notIncluded: string[] }
  | { ok: false; notFound: true };

const esc = (text: string): string => Mustache.escape(text);
const NBSP = String.fromCharCode(160);
const plain = (text: string): string => text.replaceAll(NBSP, " ");

type InvoiceRow = {
  id: string;
  invoice_number: string;
  status: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string | null;
  what: string;
  /** Methods of payments the freelancer recorded by hand, in the order received; null if none. */
  methods: string[] | null;
};

type Gathered = {
  title: string;
  totalCents: number;
  currency: string;
  clientName: string;
  clientZone: string;
  freelancer: {
    name: string;
    legalName: string | null;
    business: string | null;
    address: string | null;
    email: string;
    udyam: string | null;
  };
  client: {
    company: string | null;
    address: string | null;
    email: string;
    country: string;
    region: string | null;
    isBusiness: boolean;
  };
  invoices: InvoiceRow[];
  files: { invoice_id: string; version: number; relative_path: string }[];
  agreements: { number: string; version: number; status: string; signed_pdf_path: string | null }[];
  timeline: TimelineEntry[];
};

type TimelineEntry = {
  at: string;
  title: string;
  subject: string | null;
  body: string | null;
  /** For a recorded event: its system name and plain details, shown small under the title. */
  code?: string;
};

/** "reminders.kept_on_hold" -> "Reminders kept on hold". */
const eventTitle = (type: string): string => {
  const words = type.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const EVENT_FIELDS = ["via", "tier", "count", "number", "version", "until"] as const;

/** Only plain, known fields of an event's payload are shown: never anything else it might hold. */
const payloadText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return EVENT_FIELDS.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" || typeof value === "number"
      ? [`${key}: ${String(value)}`]
      : [];
  }).join(", ");
};

const TIER_TITLES: Record<string, string> = {
  courtesy: "Courtesy reminder sent",
  tier1: "Friendly reminder sent (Tier 1)",
  tier2: "Firm reminder sent (Tier 2)",
  tier3: "Final notice sent (Tier 3)",
  final_demand: "Final demand letter sent",
  agreement_request: "Agreement sent for signature",
  agreement_signed_copy: "Signed agreement sent",
  hold_approval: "Hold approval email sent",
  auto_pay_approval: "Auto-pay approval email sent",
};

const gather = async (db: Db, projectId: string): Promise<Gathered | undefined> => {
  const project = await getProject(db, projectId);
  if (!project) return undefined;
  const client = await getClient(db, project.clientId);
  const details = await getClientDetails(db, project.clientId);
  const { rows: me } = await db.query<{
    name: string;
    legal_name: string | null;
    business_name: string | null;
    address: string | null;
    email: string;
    udyam_number: string | null;
  }>(
    "SELECT name, legal_name, business_name, address, email, udyam_number FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const owner = me[0];
  if (!client || !owner) return undefined;
  const { rows: invoices } = await db.query<InvoiceRow>(
    `SELECT i.id::text, i.invoice_number, i.status, i.amount_cents::text, i.amount_paid_cents::text,
       i.currency, i.due_date::text, coalesce(m.name, rt.name) AS what,
       (SELECT array_agg(pay.method ORDER BY pay.created_at) FROM public.invoice_payments pay
        WHERE pay.invoice_id = i.id) AS methods
     FROM public.invoices i
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     WHERE m.project_id = $1 OR rt.project_id = $1
     ORDER BY i.created_at, i.invoice_number`,
    [projectId],
  );
  const invoiceIds = invoices.map((row) => row.id);
  const { rows: files } = await db.query<Gathered["files"][number]>(
    `SELECT invoice_id::text, version, relative_path FROM public.invoice_archive_files
     WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, version`,
    [invoiceIds],
  );
  const { rows: agreements } = await db.query<
    Gathered["agreements"][number] & { id: string; signed_at: unknown }
  >(
    `SELECT id::text, number, version, status, signed_pdf_path, signed_at FROM public.agreements
     WHERE project_id = $1 ORDER BY number, version`,
    [projectId],
  );
  const { rows: holds } = await db.query<{ id: string }>(
    `SELECT h.id::text FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id WHERE m.project_id = $1`,
    [projectId],
  );
  const agreementIds = agreements.map((row) => row.id);
  const holdIds = holds.map((row) => row.id);
  const { rows: sent } = await db.query<{
    id: string;
    at: unknown;
    tier: string;
    subject: string | null;
    body: string | null;
  }>(
    `SELECT r.id::text, r.sent_at AS at, r.tier, r.draft ->> 'subject' AS subject, r.draft ->> 'body' AS body
     FROM public.reminders r
     WHERE r.sent_at IS NOT NULL
       AND (r.invoice_id = ANY($1::uuid[]) OR r.agreement_id = ANY($2::uuid[]) OR r.hold_id = ANY($3::uuid[]))`,
    [invoiceIds, agreementIds, holdIds],
  );
  const { rows: replies } = await db.query<{ at: unknown; body: string }>(
    "SELECT created_at AS at, body FROM public.messages WHERE direction = 'in' AND invoice_id = ANY($1::uuid[])",
    [invoiceIds],
  );
  const reminderIds = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM public.reminders
       WHERE invoice_id = ANY($1::uuid[]) OR agreement_id = ANY($2::uuid[]) OR hold_id = ANY($3::uuid[])`,
      [invoiceIds, agreementIds, holdIds],
    )
  ).rows.map((row) => row.id);
  const { rows: events } = await db.query<{ at: unknown; type: string; payload: unknown }>(
    `SELECT created_at AS at, type, payload FROM public.events
     WHERE (entity = 'invoice' AND entity_id = ANY($1::uuid[]))
        OR (entity = 'agreement' AND entity_id = ANY($2::uuid[]))
        OR (entity = 'hold' AND entity_id = ANY($3::uuid[]))
        OR (entity = 'reminder' AND entity_id = ANY($4::uuid[]))
     ORDER BY created_at LIMIT 5000`,
    [invoiceIds, agreementIds, holdIds, reminderIds],
  );
  const timeline: TimelineEntry[] = [
    ...sent.map((row) => ({
      at: toIso(row.at),
      title: TIER_TITLES[row.tier] ?? "Email sent",
      subject: row.subject,
      body: row.body,
    })),
    ...replies.map((row) => ({
      at: toIso(row.at),
      title: "Reply from the client",
      subject: null,
      body: row.body,
    })),
    ...events.map((row) => ({
      at: toIso(row.at),
      title: eventTitle(row.type),
      subject: null,
      body: null,
      code: payloadText(row.payload) ? `${row.type} (${payloadText(row.payload)})` : row.type,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    title: project.title,
    totalCents: project.totalCents,
    currency: project.currency,
    clientName: client.name,
    clientZone: client.timeZone,
    freelancer: {
      name: owner.name,
      legalName: owner.legal_name,
      business: owner.business_name,
      address: owner.address,
      email: owner.email,
      udyam: owner.udyam_number,
    },
    client: {
      company: details?.company ?? null,
      address: details?.address ?? null,
      email: client.email,
      country: client.country,
      region: client.region,
      isBusiness: client.isBusiness,
    },
    invoices,
    files,
    agreements,
    timeline,
  };
};

// A quiet, professional look in the spirit of the Classic invoice theme: serif headings, a dark
// table header, generous page margins. Fonts are embedded (the PDF is made with the network off).
const STYLE = [
  "@page{size:A4;margin:22mm 20mm 24mm 20mm}",
  "*{box-sizing:border-box}",
  "body{font-family:'IBM Plex Sans',Arial,sans-serif;font-size:10pt;line-height:1.55;color:#1d1b17;margin:0}",
  "h1,h2{font-family:'IBM Plex Serif',Georgia,serif;color:#111;font-weight:600}",
  "h1{font-size:26pt;line-height:1.1;margin:0 0 2mm;letter-spacing:-.01em}",
  "h2{font-size:12.5pt;margin:9mm 0 3.5mm;padding-bottom:1.6mm;border-bottom:1px solid #d8d4c9;break-after:avoid;page-break-after:avoid}",
  "p{margin:0 0 2.5mm}",
  ".kicker{font-size:8pt;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#875B00;margin-bottom:3mm}",
  ".sub{font-size:11.5pt;color:#3d3a33;margin:0 0 1.5mm}",
  ".note{color:#5f5b52;font-size:8.8pt}",
  ".head{padding-bottom:6mm;margin-bottom:2mm;border-bottom:2.5px solid #111}",
  ".summary{display:flex;gap:4mm;margin:6mm 0 2mm}",
  ".summary div{flex:1;border:1px solid #e3dfd5;border-radius:3mm;padding:3.5mm 4mm;background:#faf9f6}",
  ".summary span{display:block;font-size:7.8pt;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#6b675e;margin-bottom:1mm}",
  ".summary b{font-family:'IBM Plex Serif',Georgia,serif;font-size:14pt;font-weight:600}",
  "table{border-collapse:collapse;width:100%;margin:1mm 0 3mm}",
  "th{background:#1f1d1a;color:#fff;font-weight:600;font-size:8.6pt;text-align:left;padding:2.2mm 3mm;letter-spacing:.02em}",
  "td{padding:2.2mm 3mm;border-bottom:1px solid #e3dfd5;vertical-align:top;font-size:9.4pt}",
  "tr{break-inside:avoid;page-break-inside:avoid}",
  "thead{display:table-header-group}",
  ".invoices td:nth-child(n+4):nth-child(-n+6){text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}",
  ".invoices th:nth-child(n+4):nth-child(-n+6){text-align:right}",
  ".parties{border-collapse:separate;border-spacing:4mm 0;margin:0 -4mm;width:calc(100% + 8mm)}",
  ".invoices td:nth-child(1),.invoices td:nth-child(3){white-space:nowrap}",
  ".parties th{background:none;color:#875B00;font-size:8pt;letter-spacing:.12em;text-transform:uppercase;padding:0 0 1.5mm}",
  ".parties td{width:50%;border:1px solid #e3dfd5;border-radius:3mm;background:#faf9f6;padding:4mm;font-size:9.6pt;line-height:1.6}",
  ".contents td:last-child{text-align:right;white-space:nowrap;width:30mm}",
  ".claim{border-left:3px solid #875B00;background:#faf9f6;padding:2.5mm 4mm;margin:0 0 2.5mm;font-size:9.4pt}",
  "ul{margin:0;padding-left:5mm}li{margin-bottom:1mm;font-size:9.4pt}",
  ".entry{margin:0 0 4mm;padding:0 0 0 4mm;border-left:3px solid #e3dfd5;break-inside:avoid;page-break-inside:avoid}",
  ".entry strong{font-size:10.2pt}",
  ".when{font-size:8.4pt;color:#6b675e;letter-spacing:.02em;margin-bottom:.6mm}",
  ".subject{font-size:9.2pt;color:#3d3a33;margin-top:.6mm}",
  ".code{font-size:8.2pt;color:#8a867c;margin-top:.4mm}",
  "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:9.2pt;line-height:1.5;margin:1.6mm 0 0;padding:2.5mm 3.5mm;background:#f6f4ef;border-radius:2mm}",
].join("");

const page = (title: string, body: string): string =>
  [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">`,
    `<title>${esc(title)}</title><style>${documentFontCss(STYLE)}${STYLE}</style></head><body>${body}</body></html>`,
  ].join("");

const lines = (parts: (string | null)[]): string =>
  parts
    .filter((part): part is string => part !== null && part !== "")
    .map(esc)
    .join("<br>");

export type Toc = { title: string; from: number; to: number }[];

type CoverInput = {
  data: Gathered;
  today: string;
  toc: Toc;
  claims: string[];
  notIncluded: string[];
};

/** How the money came: the recorded methods, else PayPal when something is paid. */
const paidBy = (row: InvoiceRow): string => {
  if (row.methods && row.methods.length > 0) {
    return [...new Set(row.methods.map(methodLabel))].join(", ");
  }
  return toCents(row.amount_paid_cents) > 0 ? "PayPal" : "";
};

const owed = (row: InvoiceRow): number =>
  toCents(row.amount_cents) - toCents(row.amount_paid_cents);

const coverHtml = ({ data, today, toc, claims, notIncluded }: CoverInput): string => {
  const money = (cents: number, currency: string): string => esc(formatMoney(cents, currency));
  const rows = data.invoices
    .map(
      (row) =>
        `<tr><td>${esc(row.invoice_number)}</td><td>${esc(row.what)}</td><td>${esc(row.due_date ? formatFullDay(row.due_date) : "none")}</td>` +
        `<td>${money(toCents(row.amount_cents), row.currency)}</td><td>${money(toCents(row.amount_paid_cents), row.currency)}</td>` +
        `<td>${money(owed(row), row.currency)}</td><td>${esc(row.status.replace("_", " "))}</td><td>${esc(paidBy(row))}</td></tr>`,
    )
    .join("");
  const same = data.invoices.filter((row) => row.currency === data.currency);
  const invoicedCents = same.reduce((sum, row) => sum + toCents(row.amount_cents), 0);
  const paidCents = same.reduce((sum, row) => sum + toCents(row.amount_paid_cents), 0);
  const outstandingCents = same
    .filter((row) => row.status !== "cancelled")
    .reduce((sum, row) => sum + Math.max(0, owed(row)), 0);
  return page(
    "Lawyer pack",
    [
      '<div class="head"><div class="kicker">GetPaid · Payment record</div>',
      "<h1>Lawyer pack</h1>",
      `<p class="sub">${esc(data.title)} · ${esc(data.clientName)}</p>`,
      `<p class="note">Prepared ${esc(formatFullDay(today))} from the records kept by GetPaid. This is a copy of records, not legal advice.</p>`,
      `<div class="summary"><div><span>Project total</span><b>${money(data.totalCents, data.currency)}</b></div><div><span>Invoiced</span><b>${money(invoicedCents, data.currency)}</b></div><div><span>Paid</span><b>${money(paidCents, data.currency)}</b></div><div><span>Outstanding</span><b>${money(outstandingCents, data.currency)}</b></div></div></div>`,
      '<h2>Parties</h2><table class="parties"><tr><th>Freelancer</th><th>Client</th></tr><tr><td>',
      lines([
        data.freelancer.legalName ?? data.freelancer.name,
        data.freelancer.business,
        data.freelancer.address,
        data.freelancer.email,
        data.freelancer.udyam ? `Udyam: ${data.freelancer.udyam}` : null,
      ]),
      "</td><td>",
      lines([
        data.clientName,
        data.client.company,
        data.client.address,
        data.client.email,
        `Country: ${data.client.country}${data.client.region ? `, ${data.client.region}` : ""}${data.client.isBusiness ? "" : " (a private person)"}`,
      ]),
      "</td></tr></table>",
      `<h2>Project</h2><p><strong>${esc(data.title)}</strong>, total ${money(data.totalCents, data.currency)}.</p>`,
      `<h2>Invoices</h2>${data.invoices.length === 0 ? "<p>No invoices yet.</p>" : `<table class="invoices"><thead><tr><th>Invoice</th><th>For</th><th>Due</th><th>Amount</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Paid by</th></tr></thead>${rows}</table>`}`,
      `<h2>Statutory interest and compensation</h2>${claims.length === 0 ? "<p>No overdue, unpaid invoice.</p>" : claims.map((c) => `<p class="claim">${esc(c)}</p>`).join("")}`,
      '<p class="note">Interest and compensation are calculated only under a law and reference rates the freelancer has checked and approved. Where none is approved, none is calculated.</p>',
      '<h2>Contents</h2><table class="contents"><thead><tr><th>Part</th><th>Pages</th></tr></thead>',
      toc
        .map(
          (item) =>
            `<tr><td>${esc(item.title)}</td><td>${item.from === item.to ? String(item.from) : `${String(item.from)} to ${String(item.to)}`}</td></tr>`,
        )
        .join(""),
      "</table>",
      notIncluded.length === 0
        ? ""
        : `<h2>Not included</h2><ul>${notIncluded.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`,
    ].join(""),
  );
};

const timelineHtml = (entries: readonly TimelineEntry[]): string =>
  page(
    "Timeline",
    `<div class="head"><div class="kicker">GetPaid · Payment record</div><h1>Timeline</h1><p class="note">Every email sent, reply received and recorded event, oldest first. Times are UTC.</p></div><h2>Events</h2>${
      entries.length === 0
        ? "<p>Nothing recorded yet.</p>"
        : entries
            .map(
              (entry) =>
                `<div class="entry"><div class="when">${esc(entry.at.slice(0, 16).replace("T", " "))} UTC</div><strong>${esc(entry.title)}</strong>` +
                (entry.code ? `<div class="code">Recorded event: ${esc(entry.code)}</div>` : "") +
                `${entry.subject ? `<div class="subject">Subject: ${esc(entry.subject)}</div>` : ""}${entry.body ? `<pre>${esc(entry.body)}</pre>` : ""}</div>`,
            )
            .join("")
    }`,
  );

/** A PDF inside the archive folder, or why it can't be used. Never reads outside the folder. */
const readInside = async (
  dir: string,
  relativePath: string,
): Promise<Buffer | "outside" | "missing"> => {
  const file = resolveInsideArchive(dir, relativePath);
  if (!file) return "outside";
  try {
    return await readFile(file);
  } catch {
    return "missing";
  }
};

const demandFiles = async (dir: string, clientName: string, title: string): Promise<string[]> => {
  const folder = demandsDirRelative(clientName, title);
  const probe = resolveInsideArchive(dir, `${folder}/x.pdf`);
  if (!probe) return [];
  try {
    const names = await readdir(dirname(probe));
    return names
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((name) => `${folder}/${name}`);
  } catch {
    return [];
  }
};

type Part = { title: string; doc: PDFDocument; pages: number };

const loadPart = async (title: string, bytes: Buffer): Promise<Part | undefined> => {
  try {
    const doc = await PDFDocument.load(bytes);
    return { title, doc, pages: doc.getPageCount() };
  } catch {
    return undefined;
  }
};

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

const NAME_ATTEMPTS = 25;

/** Builds the pack, keeps a copy in the archive folder, and returns it. Not found for anyone else's project. */
export const buildLawyerPack = async (deps: PackDeps, projectId: string): Promise<PackResult> => {
  const problem = archiveDirProblem(deps.archiveDir);
  if (problem) throw new Error(problem);
  const data = await deps.runAsUser((db) => gather(db, projectId));
  if (!data) return { ok: false, notFound: true };
  const today = todayIn(deps.now(), data.clientZone);
  const notIncluded: string[] = [];
  const parts: Part[] = [];
  const add = async (
    title: string,
    source: Promise<Buffer | "outside" | "missing">,
    label: string,
  ) => {
    const bytes = await source;
    if (bytes === "outside" || bytes === "missing") {
      notIncluded.push(
        `${label}: ${bytes === "outside" ? "its stored path is outside the archive folder, so it was not read" : "the file could not be found"}`,
      );
      return;
    }
    const part = await loadPart(title, bytes);
    if (part) parts.push(part);
    else notIncluded.push(`${label}: the file is not a readable PDF`);
  };

  const signed = data.agreements.filter((a) => a.status === "signed").at(-1);
  if (signed?.signed_pdf_path) {
    await add(
      `Signed agreement ${signed.number}, version ${String(signed.version)}`,
      readInside(deps.archiveDir, signed.signed_pdf_path),
      `Signed agreement ${signed.number}`,
    );
  }
  for (const invoice of data.invoices) {
    const versions = data.files.filter((file) => file.invoice_id === invoice.id);
    const newest = versions.at(-1);
    if (!newest) {
      notIncluded.push(`Invoice ${invoice.invoice_number}: no PDF has been saved`);
      continue;
    }
    for (const older of versions.slice(0, -1)) {
      notIncluded.push(
        `Invoice ${invoice.invoice_number}: an earlier version, ${baseName(older.relative_path)}`,
      );
    }
    await add(
      `Invoice ${invoice.invoice_number}`,
      readInside(deps.archiveDir, newest.relative_path),
      `Invoice ${invoice.invoice_number}`,
    );
  }
  const timelinePdf = await loadPart("Timeline", await deps.renderPdf(timelineHtml(data.timeline)));
  if (timelinePdf) parts.push(timelinePdf);
  for (const path of await demandFiles(deps.archiveDir, data.clientName, data.title)) {
    await add(
      `Final demand ${baseName(path)}`,
      readInside(deps.archiveDir, path),
      `Final demand ${baseName(path)}`,
    );
  }

  // The statutory calculation for each overdue, unpaid invoice, from approved laws and rates only.
  const hasAgreement = signed !== undefined;
  const claims = data.invoices.flatMap((invoice) => {
    const open = invoice.status === "sent" || invoice.status === "partially_paid";
    if (!open || !invoice.due_date || invoice.due_date >= today || owed(invoice) <= 0) return [];
    const found = lawClaim(
      {
        country: data.client.country,
        region: data.client.region,
        isBusiness: data.client.isBusiness,
        hasUdyam: data.freelancer.udyam !== null,
        outstandingCents: owed(invoice),
        currency: invoice.currency,
        dueOn: invoice.due_date,
        asOf: today,
        hasAgreement,
      },
      deps.laws,
      deps.rates,
    );
    const head = `Invoice ${invoice.invoice_number}, ${plain(formatMoney(owed(invoice), invoice.currency))} outstanding, due ${formatFullDay(invoice.due_date)}: `;
    if (!found)
      return [`${head}no approved law applies, so no interest or compensation is calculated.`];
    const { claim, law } = found;
    const interest =
      claim.interestCents === null
        ? "interest could not be calculated (no approved rate)"
        : `interest ${plain(formatMoney(claim.interestCents, invoice.currency))} (${claim.explanation.replace(/\.$/, "")})`;
    return [
      `${head}under ${law.name}: ${interest}; fixed compensation ${plain(formatMoney(claim.compensationCents, invoice.currency))}; total ${plain(formatMoney(claim.totalCents, invoice.currency))}.`,
    ];
  });

  // The cover needs the page numbers, and the page numbers need the cover's own length: render, count, repeat.
  let included = parts;
  let dropped: string[] = [];
  let coverPages = 1;
  let cover: Buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let used = coverPages;
    included = [];
    dropped = [];
    for (const part of parts) {
      if (used + part.pages > PAGE_LIMIT)
        dropped.push(`${part.title}: left out to keep the pack within ${String(PAGE_LIMIT)} pages`);
      else {
        included.push(part);
        used += part.pages;
      }
    }
    const toc: Toc = [{ title: "Cover and contents", from: 1, to: coverPages }];
    let next = coverPages + 1;
    for (const part of included) {
      toc.push({ title: part.title, from: next, to: next + part.pages - 1 });
      next += part.pages;
    }
    cover = await deps.renderPdf(
      coverHtml({
        data,
        today,
        toc,
        claims,
        notIncluded: [...notIncluded, ...dropped],
      }),
    );
    const counted = (await PDFDocument.load(cover)).getPageCount();
    if (counted === coverPages) break;
    coverPages = counted;
  }

  const out = await PDFDocument.create();
  const coverDoc = await PDFDocument.load(cover);
  for (const source of [coverDoc, ...included.map((part) => part.doc)]) {
    for (const copied of await out.copyPages(source, source.getPageIndices())) out.addPage(copied);
  }
  const bytes = Buffer.from(await out.save());

  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const relativePath = lawyerPackRelativePath({
      clientName: data.clientName,
      projectTitle: data.title,
      date: today,
      attempt,
    });
    const file = resolveInsideArchive(deps.archiveDir, relativePath);
    if (!file)
      throw new Error("A lawyer pack's archive path didn't stay inside the archive folder.");
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, bytes, { flag: "wx" });
      return {
        ok: true,
        relativePath,
        bytes,
        pages: out.getPageCount(),
        notIncluded: [...notIncluded, ...dropped],
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  throw new Error("Too many files already have this lawyer pack's name in the archive folder.");
};
