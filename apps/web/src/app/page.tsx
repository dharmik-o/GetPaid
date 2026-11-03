import Link from "next/link";

// Home: recovery metrics + Upcoming list (next 90 days of maintenance, renewals, retainer charges).
// Built in M8 and M10; until then it points to the screens that exist.

const HomePage = () => (
  <div className="page">
    <div className="page-header">
      <h1>Home</h1>
    </div>
    <div className="card empty">
      <p>Nothing needs your attention yet. Start by adding a client.</p>
      <Link className="button" href="/clients">
        Go to clients
      </Link>
    </div>
  </div>
);

export default HomePage;
