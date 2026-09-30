import { useEffect, useRef } from "react";
import bodyHtml from "@/assets/travelbase-body.html?raw";
import { PlannerAuthPortal, installAuthFetch } from "@/components/auth-chrome";

declare global {
  interface Window {
    __TB_LOADED?: boolean;
    __tbBoot?: () => void;
    L?: unknown;
    esc?: (s: string) => string;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = src.split("?")[0];
    const existing = document.querySelector(`script[src^="${key}"]`);
    if (existing) {
      const current = existing.getAttribute("src") || "";
      if (current === src) {
        resolve();
        return;
      }
      existing.remove();
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(el);
  });
}

function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}

let bootStarted = false;

export function TravelBaseApp() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    installAuthFetch();
    window.esc = escapeHtml;

    const root = rootRef.current;
    const BOOT = "tma-10";
    if (root && root.dataset.tbBooted !== BOOT) {
      root.innerHTML = bodyHtml;
      root.dataset.tbBooted = BOOT;
    }

    const scriptSrc = "/travelbase.js?v=tma-10";
    const existingScript = document.querySelector('script[src^="/travelbase.js"]');
    const stale = Boolean(existingScript && existingScript.getAttribute("src") !== scriptSrc);

    if (bootStarted && !stale) {
      // Повторный заход на главную: DOM на месте, скрипт загружен —
      // просто перезапускаем boot. Он должен быть идемпотентным,
      // а любая ошибка внутри него не должна оставлять пустой экран.
      try {
        window.__tbBoot?.();
      } catch (err) {
        console.error("TravelBase re-boot failed", err);
      }
      // Страховка: если через 2.5s карточки так и не появились —
      // перезагружаем скрипт планировщика принудительно.
      window.setTimeout(() => {
        const rootEl = document.getElementById("travelbase-root");
        const hasCards = rootEl && rootEl.querySelector(".s1-feat-card, .s1-city-card");
        if (!hasCards) {
          console.warn("TravelBase: cards missing after re-boot, reloading planner script");
          bootStarted = false;
          const s = document.querySelector('script[src^="/travelbase.js"]');
          if (s) s.remove();
          void (async () => {
            try {
              if (!window.L) await loadScript("/vendor/leaflet/leaflet.min.js");
              await loadScript(scriptSrc);
            } catch (err) {
              console.error("TravelBase recovery boot failed", err);
            }
          })();
        }
      }, 2500);
      return;
    }
    bootStarted = true;
    if (stale && existingScript) existingScript.remove();

    void (async () => {
      try {
        if (!window.L) {
          await loadScript("/vendor/leaflet/leaflet.min.js");
        }
        await loadScript(scriptSrc);
      } catch (err) {
        console.error("TravelBase boot failed", err);
        bootStarted = false;
      }
    })();
  }, []);

  return (
    <div className="relative">
      <PlannerAuthPortal />
      <div id="travelbase-root" ref={rootRef} suppressHydrationWarning />
    </div>
  );
}
