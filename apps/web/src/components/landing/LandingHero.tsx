import Link from "next/link";
import { DottedTriangle } from "@/components/DottedTriangle";

const HEADLINE = ["You did", "the work.", "Now get", "paid for it."];

const ROWS = [
  { name: "Website design, milestone 2", amount: "USD 1,200.00" },
  { name: "Extra revisions, 3 hours", amount: "USD 300.00" },
];

/** A made-up invoice. Its final state is what the server sends: the animation only plays up to it. */
const ExampleInvoice = () => (
  <div className="invoice-card" data-hero="card">
    <div className="invoice-card-top">
      <div>
        <p className="muted">FPR-000042</p>
        <p className="invoice-card-client">Northwind Studio</p>
      </div>
      <span className="invoice-pill">
        <span className="badge invoice-pill-sent" aria-hidden="true">
          Sent
        </span>
        <span className="badge badge-paid invoice-pill-paid">Paid</span>
      </span>
    </div>
    <ul className="invoice-card-rows">
      {ROWS.map((row) => (
        <li key={row.name} data-hero="row">
          <span>{row.name}</span>
          <span className="money">{row.amount}</span>
        </li>
      ))}
    </ul>
    <div className="invoice-card-total" data-hero="row">
      <span>Total</span>
      <span className="invoice-card-amount">USD 1,500.00</span>
    </div>
    <p className="invoice-card-strip" data-hero="row">
      Paid through PayPal
    </p>
    <span className="landing-stamp" aria-hidden="true" />
  </div>
);

export const LandingHero = () => (
  <section className="landing-section landing-hero" data-section>
    <DottedTriangle size={360} rotate={24} opacity={0.8} top={40} right={-120} parallax />
    <DottedTriangle size={230} rotate={190} opacity={0.6} bottom={-30} right={280} parallax />
    <DottedTriangle size={110} rotate={-30} opacity={0.6} bottom={40} left={-30} parallax />
    <div className="landing-container landing-hero-grid">
      <div>
        <h1 className="landing-headline">
          {HEADLINE.map((line) => (
            <span className="headline-mask" key={line}>
              <span className="headline-line" data-hero="line">
                {line}{" "}
              </span>
            </span>
          ))}
        </h1>
        <p className="landing-lead" data-hero="fade">
          AI drafts your payment reminders, you approve them from Telegram, and every email carries
          a PayPal pay link. Polite first, firmer later, and never sent without you.
        </p>
        <div className="landing-actions" data-hero="fade">
          <Link className="button" href="/" data-cta="hero">
            Open dashboard
          </Link>
          <a className="landing-text-link" href="#how">
            See how it works
          </a>
        </div>
      </div>
      <ExampleInvoice />
    </div>
  </section>
);
