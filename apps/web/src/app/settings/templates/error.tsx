"use client";

/** Shown when the templates fail to load. */
const TemplatesError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="page">
    <div className="banner banner-error" role="alert">
      <p>
        We couldn&apos;t load your invoice templates. Check that the database is running (
        <code>docker compose up -d</code>) and migrated (<code>npm run db:migrate</code>), then try
        again.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);

export default TemplatesError;
