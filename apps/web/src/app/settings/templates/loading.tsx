/** Skeleton while the templates load. */
const TemplatesLoading = () => (
  <div className="page" aria-busy="true">
    <span className="visually-hidden" role="status">
      Loading invoice templates…
    </span>
    <div className="page-header">
      <div className="skeleton" style={{ width: 200, height: 24 }} />
    </div>
    <div className="card">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="skeleton" style={{ margin: "12px 0" }} />
      ))}
    </div>
  </div>
);

export default TemplatesLoading;
