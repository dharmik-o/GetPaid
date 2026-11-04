import Link from "next/link";
import { DemoClockForm } from "@/components/DemoClockForm";
import { TimeZoneForm } from "@/components/TimeZoneForm";
import { UsualDelayForm } from "@/components/UsualDelayForm";
import { getOwnTimeZone, getUsualDaysLate } from "@/lib/account";
import { demoOffsetDays } from "@/lib/clock";
import { ownTimeZoneChoices } from "@/lib/countries";
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
      <p>Connect Telegram to approve drafts from your phone, and Gmail to send reminders.</p>
      <Link href="/settings/integrations">Integrations</Link>
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
