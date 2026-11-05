import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDay, formatMoney } from "@/lib/format";
import {
  filterInvoices,
  groupByProject,
  STATUS_LABELS,
  totalsByCurrency,
  type HistoryFilters,
  type HistoryInvoice,
} from "@/lib/invoice-history";
import { todayIn } from "@/lib/schedule";

// Invoices as a list: one row per saved version, newest first, or one row for an invoice with none
// yet. Rendered on the server, and the filter is a plain form, so all of it works without scripts.

type Row = {
  key: string;
  invoice: HistoryInvoice;
  version: number | null;
  sentAt: string | null;
  templateName: string | null;
  signed: boolean;
};

const rowsOf = (invoices: readonly HistoryInvoice[]): Row[] =>
  invoices.flatMap((invoice): Row[] =>
    invoice.versions.length > 0
      ? invoice.versions.map((file) => ({
          key: `${invoice.id}-${String(file.version)}`,
          invoice,
          version: file.version,
          sentAt: file.sentAt,
          templateName: file.templateName,
          signed: file.signed,
        }))
      : [
          {
            key: invoice.id,
            invoice,
            version: null,
            sentAt: invoice.sentAt,
            templateName: invoice.templateName,
            signed: invoice.signed,
          },
        ],
  );

const sentDay = (sentAt: string | null, zone: string): string =>
  sentAt ? formatDay(todayIn(new Date(sentAt), zone)) : "Not sent";

const downloadHref = ({ invoice, version }: Row): string | null => {
  if (version !== null) return `/api/invoices/${invoice.id}/versions/${String(version)}`;
  return invoice.status === "cancelled" ? null : `/api/invoices/${invoice.id}/pdf`;
};

export const InvoiceTable = ({
  invoices,
  zone,
}: {
  invoices: readonly HistoryInvoice[];
  zone: string;
}) => (
  <div className="table-scroll">
    <table className="table stack-wide history-table">
      <thead>
        <tr>
          <th scope="col">Invoice</th>
          <th scope="col">For</th>
          <th scope="col">Sent</th>
          <th scope="col" className="money">
            Amount
          </th>
          <th scope="col">Status</th>
          <th scope="col">Theme</th>
          <th scope="col">Signed</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rowsOf(invoices).map((row) => {
          const { invoice } = row;
          const download = downloadHref(row);
          return (
            <tr key={row.key}>
              <td data-label="Invoice" className="nowrap">
                {invoice.number}
                {row.version !== null && row.version > 1 ? (
                  <span className="muted"> v{row.version}</span>
                ) : null}
              </td>
              <td data-label="For">{invoice.purpose}</td>
              <td data-label="Sent" className="nowrap">
                {sentDay(row.sentAt, zone)}
              </td>
              <td className="money" data-label="Amount">
                {formatMoney(invoice.amountCents, invoice.currency)}
              </td>
              <td data-label="Status">
                <StatusBadge status={invoice.status}>{STATUS_LABELS[invoice.status]}</StatusBadge>
              </td>
              <td data-label="Theme">{row.templateName ?? "Default"}</td>
              <td data-label="Signed">{row.signed ? "Yes" : "No"}</td>
              <td data-label="Actions" className="history-actions">
                {download ? <a href={download}>Download PDF</a> : null}
                {invoice.link && invoice.status !== "cancelled" ? (
                  <a href={invoice.link} target="_blank" rel="noreferrer">
                    Open PayPal invoice
                  </a>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

type FilterProps = {
  filters: HistoryFilters;
  /** Where the form returns to. */
  action: string;
  /** Kept in the address when filtering, such as the tab this is on. */
  hidden?: Record<string, string>;
};

export const InvoiceFilters = ({ filters, action, hidden = {} }: FilterProps) => (
  <form className="history-filters" method="get" action={action}>
    {Object.entries(hidden).map(([name, value]) => (
      <input key={name} type="hidden" name={name} value={value} />
    ))}
    <div className="field">
      <label htmlFor="history-status">Status</label>
      <select id="history-status" name="status" defaultValue={filters.status ?? ""}>
        <option value="">All</option>
        {Object.entries(STATUS_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
    <div className="field">
      <label htmlFor="history-from">From</label>
      <input id="history-from" type="date" name="from" defaultValue={filters.from ?? ""} />
    </div>
    <div className="field">
      <label htmlFor="history-to">To</label>
      <input id="history-to" type="date" name="to" defaultValue={filters.to ?? ""} />
    </div>
    <button className="button button-secondary" type="submit">
      Filter
    </button>
  </form>
);

export const hasFilters = ({ status, from, to }: HistoryFilters): boolean =>
  status !== null || from !== null || to !== null;

type ClientProps = {
  clientId: string;
  invoices: readonly HistoryInvoice[];
  filters: HistoryFilters;
  zone: string;
};

/** The Client page's Invoices tab: by project, with what was sent and paid in each currency. */
export const ClientInvoices = ({ clientId, invoices, filters, zone }: ClientProps) => {
  if (invoices.length === 0) {
    return (
      <div className="card empty">
        <p>No invoices yet. They appear here once you bill one of this client&apos;s milestones.</p>
      </div>
    );
  }
  const shown = filterInvoices(invoices, filters);
  return (
    <section className="card" aria-labelledby="client-invoices">
      <h2 id="client-invoices">Invoices</h2>
      <InvoiceFilters filters={filters} action="" hidden={{ tab: "invoices" }} />
      {shown.length === 0 ? (
        <p className="muted">No invoices match these filters.</p>
      ) : (
        <>
          <ul className="history-totals" aria-label="Totals by currency">
            {totalsByCurrency(shown).map((total) => (
              <li key={total.currency}>
                <p className="muted">Total sent</p>
                <p className="metric-value">{formatMoney(total.sentCents, total.currency)}</p>
                <p className="muted">Total paid</p>
                <p className="metric-value">{formatMoney(total.paidCents, total.currency)}</p>
              </li>
            ))}
          </ul>
          {groupByProject(shown).map((group) => (
            <div key={group.key} className="history-group">
              <h3>
                {group.projectId ? (
                  <Link href={`/projects/${group.projectId}`}>{group.title}</Link>
                ) : (
                  group.title
                )}
              </h3>
              <InvoiceTable invoices={group.invoices} zone={zone} />
            </div>
          ))}
        </>
      )}
      <p className="field-hint">
        Sent dates are in your time zone ({zone}). Totals are per currency, and never converted.
        {hasFilters(filters) ? (
          <>
            {" "}
            <Link href={`/clients/${clientId}?tab=invoices`}>Clear the filters</Link>
          </>
        ) : null}
      </p>
    </section>
  );
};
