export function isTelegramWebApp() {
  if (typeof window === "undefined") return false;
  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram
      ?.WebApp;
    return Boolean(tg?.initData);
  } catch {
    return false;
  }
}
