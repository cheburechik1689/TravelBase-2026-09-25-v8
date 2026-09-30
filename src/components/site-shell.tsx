import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AuthSlot } from "./auth-chrome";
import { AppTabBar } from "./app-tab-bar";

export function SiteShell({
  children,
  tabs = true,
}: {
  children: ReactNode;
  wide?: boolean;
  tabs?: boolean;
}) {
  return (
    <div className="tb-site min-h-svh bg-paper text-ink">
      <header className="tb-shell-header">
        <div className="tb-shell-header-row">
          <Link to="/" className="tb-shell-logo">
            TravelBase
          </Link>
          <AuthSlot compact />
        </div>
        <div className="tb-shell-subtitle">Маршруты по отзывам путешественников</div>
      </header>
      <main className={"tb-shell-main" + (tabs ? " has-tabs" : "")}>{children}</main>
      {tabs ? <AppTabBar /> : null}
    </div>
  );
}
