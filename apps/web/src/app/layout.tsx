import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoClockBanner } from "@/components/DemoClockBanner";
import { Logo } from "@/components/Logo";
import { Sidebar } from "@/components/Sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BRAND_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: "Get paid on time: deposits, milestones and approved reminders with a PayPal link.",
};

/**
 * App shell: sidebar navigation, a header with the theme toggle, and one main column.
 * suppressHydrationWarning: the theme script sets data-theme on <html> before React loads.
 */
const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      <link
        rel="preload"
        href="/fonts/ClashDisplay-Semibold.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
    </head>
    <body>
      <ThemeProvider>
        <div className="shell">
          <Sidebar />
          <div className="shell-main">
            <header className="app-header">
              <Logo />
              <ThemeToggle />
            </header>
            <main className="content">
              <DemoClockBanner />
              {children}
            </main>
          </div>
        </div>
      </ThemeProvider>
    </body>
  </html>
);

export default RootLayout;
