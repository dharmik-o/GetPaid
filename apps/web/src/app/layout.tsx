import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { DemoClockBanner } from "@/components/DemoClockBanner";
import { DemoModeBanner } from "@/components/DemoModeBanner";
import { ThemeProvider } from "@/components/ThemeProvider";
import { BRAND_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: BRAND_NAME,
  icons: { icon: "/getpaid-stamp.svg" },
  description: "Get paid on time: deposits, milestones and approved reminders with a PayPal link.",
};

/**
 * The document, with the app shell around every page but the landing page.
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
        <AppShell
          banner={
            <>
              <DemoModeBanner />
              <DemoClockBanner />
            </>
          }
        >
          {children}
        </AppShell>
      </ThemeProvider>
    </body>
  </html>
);

export default RootLayout;
