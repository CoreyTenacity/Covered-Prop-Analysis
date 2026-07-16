"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountStatus } from "./account-status";
import { Logo } from "./logo";
import { primaryNavLinks as nav } from "./nav-links";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand"><Logo /></div>
        <nav className="sidebar__nav" aria-label="Primary navigation">
        {nav.map(([label, href]) => (
          <Link className={pathname === href ? "nav-link nav-link--active" : "nav-link"} href={href} key={href}>
            <span className="nav-link__icon" aria-hidden="true">
              <span className="nav-link__dot" />
            </span>
            {label}
          </Link>
        ))}
        </nav>
        <AccountStatus />
        <div className="sidebar__footer">
          <span className="status-dot" />
          <div>
            <strong>Browser refresh disabled</strong>
            <span>Server snapshots update the board without client polling.</span>
          </div>
        </div>
      </aside>
      <header className="mobile-header">
        <Logo compact />
      </header>
      <main className="main-content">{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(([label, href]) => (
          <Link className={pathname === href ? "mobile-nav__item active" : "mobile-nav__item"} href={href} key={href}>
            <span aria-hidden="true" className="mobile-nav__dotWrap"><span className="mobile-nav__dot" /></span>
            <small>{label === "Parlay Builder" ? "Builder" : label === "My Picks" ? "Picks" : label}</small>
          </Link>
        ))}
      </nav>
    </div>
  );
}
