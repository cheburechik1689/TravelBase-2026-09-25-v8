import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Раздел «Тарифы» живёт внутри планировщика (/?tab=pricing) —
// переключается мгновенно, без перезагрузки. Этот маршрут — быстрый редирект
// для прямых ссылок и старых закладок.
export const Route = createFileRoute("/pricing")({ component: PricingRedirect });

function PricingRedirect() {
  useEffect(() => {
    window.location.replace("/?tab=pricing");
  }, []);
  return null;
}
