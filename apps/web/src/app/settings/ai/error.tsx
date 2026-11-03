"use client";

/** Shown when the AI settings fail to load. */
const AiSettingsError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="page">
    <div className="banner banner-error" role="alert">
      <p>
        We couldn&apos;t load your AI settings. Check that the database is running (
        <code>docker compose up -d</code>) and that ENCRYPTION_KEY is set, then try again.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);

export default AiSettingsError;
