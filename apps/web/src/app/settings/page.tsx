import Link from "next/link";

// Settings hub. The AI settings (M4) and invoice templates (M5) exist; account schedule defaults and integrations come
// later, so they're marked as such.

const SettingsPage = () => (
  <div className="page">
    <div className="page-header">
      <h1>Settings</h1>
    </div>
    <section className="card" aria-labelledby="settings-ai">
      <h2 id="settings-ai">AI model</h2>
      <p>Pick a cloud or local model, enter its key, and test the connection.</p>
      <Link className="button" href="/settings/ai">
        Open AI settings
      </Link>
    </section>
    <section className="card" aria-labelledby="settings-templates">
      <h2 id="settings-templates">Invoice templates</h2>
      <p>
        Pick or write the template for your invoice PDFs, and add your business details and logo.
      </p>
      <Link className="button" href="/settings/templates">
        Open invoice templates
      </Link>
    </section>
    <section className="card" aria-labelledby="settings-integrations">
      <h2 id="settings-integrations">Integrations</h2>
      <p className="muted">Telegram and Gmail connections arrive in M6 and M7.</p>
      <Link href="/settings/integrations">Integrations</Link>
    </section>
    <section className="card" aria-labelledby="settings-schedule">
      <h2 id="settings-schedule">Default schedule</h2>
      <p className="muted">
        Account-wide defaults (terms, grace period, intervals, tiers, send window) don&apos;t have a
        screen yet; projects use the spec defaults and their own overrides.
      </p>
    </section>
  </div>
);

export default SettingsPage;
