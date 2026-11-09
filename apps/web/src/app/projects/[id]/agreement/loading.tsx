/** Skeleton while the agreement loads. */
const AgreementLoading = () => (
  <div className="page" aria-busy="true">
    <span className="visually-hidden" role="status">
      Loading the agreement…
    </span>
    <div className="page-header">
      <div className="skeleton" style={{ width: 240, height: 24 }} />
    </div>
    <div className="card">
      {[0, 1, 2].map((row) => (
        <div key={row} className="skeleton" style={{ margin: "12px 0" }} />
      ))}
    </div>
  </div>
);

export default AgreementLoading;
