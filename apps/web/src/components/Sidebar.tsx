"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type NavItem = { href: string; label: string; onPhone: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Home", onPhone: true },
  { href: "/outbox", label: "Outbox", onPhone: true },
  { href: "/clients", label: "Clients", onPhone: true },
  { href: "/projects", label: "Projects", onPhone: false },
  { href: "/retainers", label: "Retainers", onPhone: false },
  { href: "/maintenance", label: "Maintenance", onPhone: false },
  { href: "/settings", label: "Settings", onPhone: false },
];

const isActive = (pathname: string, href: string): boolean =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);

const BADGE_REFRESH_MS = 30_000;

/** Drafts waiting for review. A failed check keeps the last count: the badge is only a hint. */
const useWaitingCount = (pathname: string): number => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/outbox/summary");
        if (response.ok) setCount(((await response.json()) as { waiting: number }).waiting);
      } catch {
        // Offline: keep the last count until the next check.
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, BADGE_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [pathname]);
  return count;
};

/** Left sidebar; on phones it becomes a bottom bar (see globals.css). */
export const Sidebar = () => {
  const pathname = usePathname();
  const waiting = useWaitingCount(pathname);
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-brand">Payment Recovery</div>
      <ul>
        {NAV.map((item) => (
          <li key={item.href} className={item.onPhone ? undefined : "desktop-only"}>
            <Link
              href={item.href}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
              {item.href === "/outbox" && waiting > 0 ? (
                <span className="count-badge">
                  {waiting}
                  <span className="visually-hidden"> waiting</span>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        <li className="more">
          <Link href="/settings">More</Link>
        </li>
      </ul>
    </nav>
  );
};
