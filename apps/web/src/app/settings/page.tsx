import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { DemoClockForm } from "@/components/DemoClockForm";
import { LegalFactsForm } from "@/components/LegalFactsForm";
import { TimeZoneForm } from "@/components/TimeZoneForm";
import { TourSettings } from "@/components/TourSettings";
import { UsualDelayForm } from "@/components/UsualDelayForm";
import { getLegalFacts, getOwnTimeZone, getUsualDaysLate } from "@/lib/account";
import { defaultArchiveDir } from "@/lib/archive-paths";
import { demoOffsetDays } from "@/lib/clock";
import { COUNTRIES, ownTimeZoneChoices } from "@/lib/countries";
import { runAsCurrentUser } from "@/lib/request-user";

// Settings hub. The AI settings (M4), invoice templates (M5) and your time zone (M6) exist;
// account schedule defaults and integrations come later, so they're marked as such.

export const dynamic = "force-dynamic";

const SettingsPage = async () => (
  <div className="page">
    <div className="page-header">
      <h1>Settings</h1>
    </div>
    <section className="card" aria-labelledby="settings-time-zone">
      <h2 id="settings-time-zone">Time zone</h2>
      <p>The Outbox shows each send time in your client&apos;s zone and in this one.</p>
      <TimeZoneForm
        current={await runAsCurrentUser((db) => getOwnTimeZone(db))}
        zones={ownTimeZoneChoices()}
      />
    </section>
    <section className="card" aria-labelledby="settings-usual-delay">
      <h2 id="settings-usual-delay">How late clients usually pay you</h2>
      <p>Days saved on Home compares against this. Leave it empty if you&apos;d rather not say.</p>
      <UsualDelayForm current={await runAsCurrentUser((db) => getUsualDaysLate(db))} />
    </section>
    <section className="card" aria-labelledby="settings-legal">
      <h2 id="settings-legal">Legal details</h2>
      <p>
        Used in agreements and to decide which late-payment laws can be cited. Nothing here is legal
        advice.
      </p>
      <LegalFactsForm
        current={await runAsCurrentUser((db) => getLegalFacts(db))}
        countries={COUNTRIES.map(({ code, name }) => ({ code, name }))}
      />
    </section>
    <section className="card" aria-labelledby="settings-ai">
      <h2 id="settings-ai">AI model</h2>
      <p>Pick a cloud or local model, enter its key, and test the connection.</p>
      <Link className="button button-secondary" href="/settings/ai">
        Open AI settings
      </Link>
    </section>
    <section className="card" aria-labelledby="settings-templates">
      <h2 id="settings-templates">Invoice templates</h2>
      <p>
        Pick or write the template for your invoice PDFs, and add your business details and logo.
      </p>
      <Link className="button button-secondary" href="/settings/templates">
        Open invoice templates
      </Link>
    </section>
    <section className="card" aria-labelledby="settings-archive">
      <h2 id="settings-archive">Invoice archive</h2>
      <p>
        Every invoice PDF sent to a client is saved here, by client and project. Nothing in it is
        ever overwritten or deleted. It holds client data, so back it up. To move it, set
        INVOICE_ARCHIVE_DIR.
      </p>
      <div className="archive-path">
        <code>{defaultArchiveDir()}</code>
        <CopyButton value={defaultArchiveDir()} label="Copy the archive folder's path" />
      </div>
    </section>
    <section className="card" aria-labelledby="settings-tour">
      <h2 id="settings-tour">Guided tour</h2>
      <p>Walk through the dashboard again, or bring back the tips that show on a page&apos;s first visit.</p>
      <TourSettings />
    </section>
    <section className="card" aria-labelledby="settings-integrations">
      <h2 id="settings-integrations">Integrations</h2>
      <p>Connect Telegram to approve drafts from your phone, and Gmail to send reminders.</p>
      <Link className="button button-secondary" href="/settings/integrations">
        Integrations
      </Link>
    </section>
    {process.env.NODE_ENV === "production" ? null : (
      <section className="card" aria-labelledby="settings-demo-clock">
        <h2 id="settings-demo-clock">Demo clock (development only)</h2>
        <p>
          Moves this app&apos;s clock forward, so a demo can jump past a due date. Restarting the
          server goes back to <code>DEMO_CLOCK_OFFSET_DAYS</code>, or to the real time.
        </p>
        <DemoClockForm current={demoOffsetDays()} />
      </section>
    )}
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
