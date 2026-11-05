import { DottedTriangle } from "@/components/DottedTriangle";

const STEPS = [
  {
    title: "Set the rules.",
    text: "Deadline, payment terms, milestones, and how firm reminders get.",
  },
  {
    title: "AI drafts the reminder.",
    text: "On schedule, in your client's working hours, with the PayPal link built in.",
  },
  {
    title: "You approve it.",
    text: "Tap Approve, Edit or Skip on Telegram, or in the Outbox.",
  },
  {
    title: "You get paid.",
    text: "PayPal tells the app the moment it's paid, and the reminders stop by themselves.",
  },
];

export const LandingHow = () => (
  <section className="landing-section" id="how" data-section>
    <DottedTriangle size={280} rotate={150} opacity={0.5} top={30} right={-110} parallax />
    <div className="landing-container">
      <div data-reveal>
        <h2 className="landing-title">Set the rules once. After that, it&apos;s one tap.</h2>
        <p className="landing-lead">
          Your reminders run on a schedule you choose, in your client&apos;s time zone, from your
          own Gmail.
        </p>
      </div>
      <div className="how-steps-wrap" data-how>
        <div className="how-track" aria-hidden="true">
          <span className="how-track-fill" />
        </div>
        <ol className="how-steps">
          {STEPS.map((step, index) => (
            <li className="how-step" key={step.title}>
              <span className="how-circle" aria-hidden="true">
                {index + 1}
                <span className="how-circle-fill">{index + 1}</span>
              </span>
              <h3>{step.title}</h3>
              <p className="muted">{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  </section>
);
