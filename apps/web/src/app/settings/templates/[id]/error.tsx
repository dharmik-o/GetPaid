"use client";

/** Shown when the template fails to load. */
const TemplateError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="page">
    <div className="banner banner-error" role="alert">
      <p>
        We couldn&apos;t load this template. Check that the database is running (
        <code>docker compose up -d</code>) and migrated (<code>npm run db:migrate</code>), then try
        again.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);

export default TemplateError;
