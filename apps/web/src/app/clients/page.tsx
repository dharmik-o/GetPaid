import Link from "next/link";
import { listClients, type Client } from "@/lib/clients";
import { formatDaysAgo, formatMoney } from "@/lib/format";
import { runAsCurrentUser } from "@/lib/request-user";

// All clients: name, country, open balance, last activity.

export const dynamic = "force-dynamic";

const OpenBalance = ({ client }: { client: Client }) =>
  client.openBalances.length === 0 ? (
    <span className="muted">Nothing owed</span>
  ) : (
    <>
      {client.openBalances.map((balance) => (
        <div key={balance.currency}>{formatMoney(balance.cents, balance.currency)}</div>
      ))}
    </>
  );

const ClientsPage = async () => {
  const clients = await runAsCurrentUser((db) => listClients(db));
  const now = new Date();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Clients</h1>
        {clients.length > 0 ? (
          <Link className="button" href="/clients/new">
            Add client
          </Link>
        ) : null}
      </div>
      {clients.length === 0 ? (
        <div className="card empty">
          <p>No clients yet. Add a client, then set up a project with deadlines and reminders.</p>
          <Link className="button" href="/clients/new">
            Add your first client
          </Link>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Country</th>
              <th scope="col" className="money">
                Open balance
              </th>
              <th scope="col" className="hide-small">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id}>
                <td>
                  <Link href={`/clients/${client.id}`}>{client.name}</Link>
                </td>
                <td>{client.countryName}</td>
                <td className="money">
                  <OpenBalance client={client} />
                </td>
                <td className="hide-small">
                  {formatDaysAgo(new Date(client.lastActivityAt), now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default ClientsPage;
