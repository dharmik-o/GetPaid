"use client";

/** Shown when a Settings screen fails to load. */
const SettingsError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="page">
    <div className="banner banner-error" role="alert">
      <p>
        We couldn&apos;t load your settings. Check that the database is running (
        <code>docker compose up -d</code>) and that migrations are applied (
        <code>npm run db:migrate</code>), then try again.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);

export default SettingsError;
