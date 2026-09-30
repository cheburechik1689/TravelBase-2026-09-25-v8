import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Раздел «Личный кабинет» живёт внутри планировщика (/?tab=cabinet) —
// переключается мгновенно, без перезагрузки. Этот маршрут — быстрый редирект
// для прямых ссылок и старых закладок.
export const Route = createFileRoute("/cabinet")({ component: CabinetRedirect });

function CabinetRedirect() {
  useEffect(() => {
    window.location.replace("/?tab=cabinet");
  }, []);
  return null;
}
