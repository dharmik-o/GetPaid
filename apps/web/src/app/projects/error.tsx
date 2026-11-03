"use client";

/** Shown when a project screen fails to load. */
const ProjectsError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="page">
    <div className="banner banner-error" role="alert">
      <p>
        We couldn&apos;t load this project. Check that the database is running (
        <code>docker compose up -d</code>), then try again.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);

export default ProjectsError;
