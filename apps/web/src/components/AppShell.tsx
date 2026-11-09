"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { Sidebar } from "@/components/Sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";

/** The landing page brings its own nav and footer; the demo sign-in has no menu to offer yet. */
const NO_SHELL = new Set(["/welcome", "/demo-login"]);
/** The public signing pages show one agreement and nothing of the dashboard. */
const NO_SHELL_PREFIX = "/sign/";

type Props = { banner: ReactNode; children: ReactNode };

/** Sidebar navigation, a header with the theme toggle, and one main column. */
export const AppShell = ({ banner, children }: Props) => {
  const pathname = usePathname();
  if (NO_SHELL.has(pathname) || pathname.startsWith(NO_SHELL_PREFIX)) return <>{children}</>;
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell-main">
        <header className="app-header">
          <Logo />
          <ThemeToggle />
        </header>
        <main className="content">
          {banner}
          {children}
        </main>
      </div>
    </div>
  );
};
