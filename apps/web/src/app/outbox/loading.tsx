/** Skeleton while the drafts load. */
const OutboxLoading = () => (
  <div className="page" aria-busy="true">
    <span className="visually-hidden" role="status">
      Loading drafts…
    </span>
    <div className="page-header">
      <div className="skeleton" style={{ width: 120, height: 24 }} />
    </div>
    {[0, 1].map((card) => (
      <div key={card} className="card">
        <div className="skeleton" style={{ margin: "12px 0" }} />
        <div className="skeleton" style={{ margin: "12px 0", height: 96 }} />
      </div>
    ))}
  </div>
);

export default OutboxLoading;
