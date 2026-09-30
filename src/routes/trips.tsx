import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Раздел «Мои путешествия» живёт внутри планировщика (/?tab=trips) —
// переключается мгновенно, без перезагрузки. Этот маршрут — быстрый редирект
// для прямых ссылок и старых закладок.
export const Route = createFileRoute("/trips")({ component: TripsRedirect });

function TripsRedirect() {
  useEffect(() => {
    window.location.replace("/?tab=trips");
  }, []);
  return null;
}
