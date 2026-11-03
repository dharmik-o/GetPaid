/** Skeleton while a project screen loads. */
const ProjectsLoading = () => (
  <div className="page" aria-busy="true">
    <span className="visually-hidden" role="status">
      Loading project…
    </span>
    <div className="page-header">
      <div className="skeleton" style={{ width: 160, height: 24 }} />
    </div>
    <div className="card">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="skeleton" style={{ margin: "12px 0" }} />
      ))}
    </div>
  </div>
);

export default ProjectsLoading;
