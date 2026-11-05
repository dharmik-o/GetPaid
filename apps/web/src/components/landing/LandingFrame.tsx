import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BRAND_NAME } from "@/lib/brand";

export const LandingNav = () => (
  <header className="landing-nav">
    <nav className="landing-nav-inner" aria-label="Main">
      <Logo />
      <div className="landing-nav-links">
        <a href="#how">How it works</a>
        <a href="#features">Features</a>
      </div>
      <div className="landing-nav-actions">
        <ThemeToggle />
        <Link className="button" href="/" data-cta="header">
          Open dashboard
        </Link>
      </div>
    </nav>
  </header>
);

export const LandingFooter = () => (
  <footer className="landing-footer">
    <div className="landing-container landing-footer-inner">
      <Logo />
      <nav className="landing-footer-links" aria-label="Footer">
        <a href="#how">How it works</a>
        <a href="#features">Features</a>
        <Link href="/">Dashboard</Link>
      </nav>
      <p className="muted">© 2026 {BRAND_NAME}</p>
    </div>
  </footer>
);
