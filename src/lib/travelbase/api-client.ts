import { getBearerToken } from "@/lib/auth/client";

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getBearerToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  try {
    const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp
      ?.initData;
    if (tg && !headers.has("X-Telegram-Init-Data")) headers.set("X-Telegram-Init-Data", tg);
  } catch {
    /* ignore */
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const data = (await parseApiJson(res)) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

// Продакшн-сборка иногда оборачивает JSON ответа в HTML-префикс/суффикс —
// извлекаем объект устойчиво.
async function parseApiJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const raw = await res.text();
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      let start = raw.indexOf('{"success"');
      if (start < 0) start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
          /* fall through */
        }
      }
      return {};
    }
  } catch {
    return {};
  }
}

export function formatRub(n: number) {
  return new Intl.NumberFormat("ru-RU").format(n) + " ₽";
}

export function safeNextPath(raw: string | null | undefined) {
  if (!raw) return "/cabinet";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/cabinet";
  return raw;
}
