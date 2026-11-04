import Link from "next/link";
import { RetainerAlerts } from "@/components/RetainerAlerts";
import { RetainerCard } from "@/components/RetainerCard";
import { appNow } from "@/lib/clock";
import { runAsCurrentUser } from "@/lib/request-user";
import { listRetainerAlerts, listRetainers } from "@/lib/retainers";

// Recurring fees: auto-pay (PayPal subscription) or invoice each cycle.

export const dynamic = "force-dynamic";

const RetainersPage = async () => {
  const now = appNow();
  const { retainers, alerts } = await runAsCurrentUser(async (db) => ({
    retainers: await listRetainers(db, now),
    alerts: await listRetainerAlerts(db),
  }));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Retainers</h1>
        {retainers.length > 0 ? (
          <Link className="button" href="/retainers/new">
            Add retainer
          </Link>
        ) : null}
      </div>
      <RetainerAlerts alerts={alerts} />
      {retainers.length === 0 ? (
        <div className="card empty">
          <p>
            No retainers yet. Add a recurring fee: the client approves auto-pay once, or gets an
            invoice each cycle.
          </p>
          <Link className="button" href="/retainers/new">
            Add retainer
          </Link>
        </div>
      ) : (
        retainers.map((retainer) => <RetainerCard key={retainer.id} retainer={retainer} />)
      )}
    </div>
  );
};

export default RetainersPage;
