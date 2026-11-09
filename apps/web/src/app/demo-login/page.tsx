import type { Metadata } from "next";
import { DemoLoginForm } from "@/components/DemoLoginForm";
import { BRAND_NAME } from "@/lib/brand";
import { safeNext } from "@/lib/demo-gate";

export const metadata: Metadata = {
  title: `${BRAND_NAME}: demo sign-in`,
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/** The page the demo gate sends visitors to. The sandbox keeps payments and email harmless. */
const DemoLoginPage = async ({ searchParams }: { searchParams: Promise<{ next?: string }> }) => {
  const { next } = await searchParams;
  return (
    <main className="content">
      <div className="page-header">
        <h1>Demo sign-in</h1>
      </div>
      <section className="card" aria-labelledby="demo-login-heading">
        <h2 id="demo-login-heading">Enter the demo password</h2>
        <p className="field-hint">
          This is a public demo with sandbox payments, and emails only go to the demo inbox. The
          password was given to you with the link.
        </p>
        <DemoLoginForm next={safeNext(next)} />
      </section>
    </main>
  );
};

export default DemoLoginPage;
