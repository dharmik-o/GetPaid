import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payment Recovery",
  description: "Get paid on time: deposits, milestones and approved reminders with a PayPal link.",
};

/** App shell: sidebar navigation and one main column. */
const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>
      <div className="shell">
        <Sidebar />
        <main className="content">{children}</main>
      </div>
    </body>
  </html>
);

export default RootLayout;
