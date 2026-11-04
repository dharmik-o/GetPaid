/** Skeleton while Settings loads. */
const SettingsLoading = () => (
  <div className="page" aria-busy="true">
    <span className="visually-hidden" role="status">
      Loading settings…
    </span>
    <div className="page-header">
      <div className="skeleton" style={{ width: 120, height: 24 }} />
    </div>
    <div className="card">
      <div className="skeleton" style={{ margin: "12px 0" }} />
    </div>
  </div>
);

export default SettingsLoading;
