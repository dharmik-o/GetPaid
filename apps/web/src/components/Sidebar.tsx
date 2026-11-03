"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; onPhone: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Home", onPhone: true },
  { href: "/outbox", label: "Outbox", onPhone: true },
  { href: "/clients", label: "Clients", onPhone: true },
  { href: "/projects/new", label: "Projects", onPhone: false },
  { href: "/retainers", label: "Retainers", onPhone: false },
  { href: "/maintenance", label: "Maintenance", onPhone: false },
  { href: "/settings", label: "Settings", onPhone: false },
];

const isActive = (pathname: string, href: string): boolean =>
  href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/new$/, ""));

/** Left sidebar; on phones it becomes a bottom bar (see globals.css). */
export const Sidebar = () => {
  const pathname = usePathname();
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
