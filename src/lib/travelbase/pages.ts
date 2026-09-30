import type { PlanJson } from "./plan-schema";
import { newId } from "./json";

export type PageKind = "day" | "hotels" | "tips" | "budget";

export type TripPage = {
  id: string;
  kind: PageKind;
  sortOrder: number;
  title: string;
  body: unknown;
};

export function pagesFromPlan(plan: PlanJson): Omit<TripPage, "id">[] {
  const pages: Omit<TripPage, "id">[] = plan.days.map((d, i) => ({
    kind: "day" as const,
    sortOrder: i,
    title: `День ${d.day}`,
    body: d,
  }));
  pages.push({
    kind: "hotels",
    sortOrder: 100,
    title: "Отели",
    body: { hotels: plan.hotels || [] },
  });
  pages.push({
    kind: "budget",
    sortOrder: 101,
    title: "Бюджет",
    body: plan.dailyBudget || {},
  });
  pages.push({
    kind: "tips",
    sortOrder: 102,
    title: "Лайфхаки",
    body: { tips: plan.tips || [] },
  });
  return pages;
}

export function withPageIds(pages: Omit<TripPage, "id">[]): TripPage[] {
  return pages.map((p) => ({ ...p, id: newId("pg") }));
}
