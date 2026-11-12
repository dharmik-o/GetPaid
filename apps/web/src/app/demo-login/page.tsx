import type { Metadata } from "next";
import Link from "next/link";
import { DemoLoginForm } from "@/components/DemoLoginForm";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BRAND_NAME } from "@/lib/brand";
import { safeNext } from "@/lib/demo-gate";

export const metadata: Metadata = {
  title: `${BRAND_NAME}: sign in`,
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/** The page the demo gate sends visitors to. The sandbox keeps payments and email harmless. */
const DemoLoginPage = async ({ searchParams }: { searchParams: Promise<{ next?: string }> }) => {
  const { next } = await searchParams;
  return (
    <main className="login">
      <div className="login-theme">
        <ThemeToggle />
      </div>
      <div className="login-panel">
        <Logo large />
        <section className="login-card" aria-labelledby="demo-login-heading">
          <h1 id="demo-login-heading">Sign in</h1>
          <p className="login-lead">
            A public demo: payments are sandbox and emails only go to the demo inbox. Use the
            username and password that came with the link.
          </p>
          <DemoLoginForm next={safeNext(next)} />
        </section>
        <Link className="login-back" href="/welcome">
          Back to the welcome page
        </Link>
      </div>
    </main>
  );
};

export default DemoLoginPage;
