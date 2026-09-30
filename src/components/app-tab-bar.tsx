import { Briefcase, Compass, Ticket, UserRound } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";

const ITEMS = [
  { to: "/", label: "Главная", icon: Compass, match: (p: string) => p === "/" },
  { to: "/trips", label: "Поездки", icon: Briefcase, match: (p: string) => p.startsWith("/trips") },
  {
    to: "/pricing",
    label: "Тарифы",
    icon: Ticket,
    match: (p: string) => p.startsWith("/pricing") || p.startsWith("/checkout"),
  },
  {
    to: "/cabinet",
    label: "Кабинет",
    icon: UserRound,
    match: (p: string) =>
      p.startsWith("/cabinet") || p.startsWith("/offer"),
  },
] as const;

export function AppTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="app-tabbar" aria-label="Основное меню">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={active ? "is-active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            <Icon strokeWidth={active ? 2.4 : 2} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
