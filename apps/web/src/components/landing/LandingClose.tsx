import Link from "next/link";
import { DottedTriangle } from "@/components/DottedTriangle";

const STATEMENT =
  "Less time chasing clients for money. More time doing the work they hired you for.";

/** Each word is its own span, so scrolling can fill them in reading order. */
export const LandingBand = () => (
  <section className="landing-band" data-section data-band>
    <DottedTriangle
      size={300}
      rotate={35}
      opacity={0.5}
      top={-40}
      right={-90}
      variant="ink"
      parallax
    />
    <DottedTriangle
      size={150}
      rotate={200}
      opacity={0.5}
      bottom={-20}
      left={-40}
      variant="ink"
      parallax
    />
    <p className="landing-container band-text">
      {STATEMENT.split(" ").map((word, index) => (
        <span key={`${word}-${String(index)}`}>
          <span className="band-word">{word}</span>{" "}
        </span>
      ))}
    </p>
  </section>
);

export const LandingFinal = () => (
  <section className="landing-section landing-final" data-section>
    <DottedTriangle size={250} rotate={-25} opacity={0.6} top={50} left={-90} parallax />
    <DottedTriangle size={200} rotate={170} opacity={0.6} bottom={40} right={-70} parallax />
    <div className="landing-container" data-reveal>
      <h2 className="landing-title">Set up your first reminder schedule.</h2>
      <p className="landing-lead">
        It runs on your own Gmail, Telegram and PayPal accounts, and nothing is ever sent without
        your approval.
      </p>
      <Link className="button" href="/" data-cta="final">
        Open dashboard
      </Link>
    </div>
  </section>
);
