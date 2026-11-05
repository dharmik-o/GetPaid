import { DottedTriangle } from "@/components/DottedTriangle";

const TIMELINE = [
  { when: "Before the due date:", what: "a friendly heads-up" },
  { when: "Day 1 late:", what: "a polite reminder with the pay link up front" },
  { when: "Day 8:", what: "a clear, firmer nudge" },
  { when: "Day 22:", what: "a final notice, and only if you approve it" },
];

const CLIENTS = [
  { name: "Northwind Studio", amount: "USD 1,500.00", status: "Paid", tone: "badge-paid" },
  { name: "Pixel and Pine", amount: "EUR 800.00", status: "Scheduled", tone: "" },
  { name: "Kite Coffee Co.", amount: "GBP 450.00", status: "Overdue", tone: "badge-overdue" },
];

const MODELS = ["Local (Ollama)", "Claude", "OpenAI"];

/** A picture of a control, not a control. These snippets do nothing when pressed. */
const FakeButton = ({ primary = false, label }: { primary?: boolean; label: string }) => (
  <span className={primary ? "snippet-button is-primary" : "snippet-button"}>{label}</span>
);

const Reminders = () => (
  <article className="landing-panel panel-wide" data-panel>
    <h3>Reminders that escalate, politely</h3>
    <p className="muted">
      Courtesy first, then firmer. The final notice cites only your contract&apos;s late-fee clause,
      and it never invents a law or a fee.
    </p>
    <ul className="snippet-timeline">
      {TIMELINE.map((row) => (
        <li key={row.when} data-item>
          <strong>{row.when}</strong> {row.what}
        </li>
      ))}
    </ul>
  </article>
);

const Approve = () => (
  <article className="landing-panel panel-narrow" data-panel>
    <h3>Approve from your phone</h3>
    <p className="muted">
      Every draft waits for you. One tap on Telegram, and it goes out on your own Gmail thread.
    </p>
    <div className="snippet-card" data-item>
      <p>
        <strong>Tier 1 · Northwind Studio · USD 1,500.00</strong>
      </p>
      <p className="muted">Sends Tue 10:00 their time (20:30 yours)</p>
      <div className="snippet-buttons">
        <FakeButton primary label="Approve" />
        <FakeButton label="Edit" />
        <FakeButton label="Skip" />
      </div>
    </div>
  </article>
);

const Replies = () => (
  <article className="landing-panel panel-narrow" data-panel>
    <h3>Replies, read for you</h3>
    <p className="muted">
      When a client writes back, reminders pause until you decide. The AI reads the reply and
      suggests the next step. It can&apos;t change anything by itself.
    </p>
    <div className="snippet-card" data-item>
      <p className="muted">Client: &quot;Can I pay this in two parts?&quot;</p>
      <p>
        Suggestion: <strong>Installments</strong>. Split the remaining USD 1,500.00 into 2.
      </p>
      <div className="snippet-buttons">
        <FakeButton primary label="Split into 2" />
        <FakeButton label="Resume reminders" />
      </div>
    </div>
  </article>
);

const Billing = () => (
  <article className="landing-panel panel-wide" data-panel>
    <h3>Every way you bill</h3>
    <p className="muted">
      Deposits, milestones, installments, retainers with auto-pay, maintenance and renewal
      reminders, and milestone holds that secure the money before you start.
    </p>
    <ul className="snippet-clients">
      {CLIENTS.map((client) => (
        <li key={client.name} data-item>
          <span>{client.name}</span>
          <span className="money">{client.amount}</span>
          <span className={`badge ${client.tone}`}>{client.status}</span>
        </li>
      ))}
    </ul>
  </article>
);

const YourAi = () => (
  <article className="landing-panel panel-full" data-panel>
    <div>
      <h3>Your AI, your choice</h3>
      <p className="muted">
        Run a local model so client emails never leave your computer, or connect Claude, OpenAI or
        Gemini.
      </p>
    </div>
    <ul className="snippet-pills">
      {MODELS.map((model) => (
        <li className="badge" key={model} data-item>
          {model}
        </li>
      ))}
    </ul>
  </article>
);

export const LandingFeatures = () => (
  <section className="landing-section" id="features" data-section>
    <DottedTriangle size={240} rotate={-20} opacity={0.5} top={60} left={-110} parallax />
    <div className="landing-container">
      <h2 className="landing-title" data-reveal>
        Built around how freelancers actually get paid.
      </h2>
      <div className="landing-panels" data-panels>
        <Reminders />
        <Approve />
        <Replies />
        <Billing />
        <YourAi />
      </div>
    </div>
  </section>
);
