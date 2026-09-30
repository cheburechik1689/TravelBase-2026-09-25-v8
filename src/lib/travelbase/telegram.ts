import { createHmac, timingSafeEqual } from "node:crypto";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

function parseInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const userRaw = params.get("user");
  let user: TelegramWebAppUser | null = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramWebAppUser;
    } catch {
      user = null;
    }
  }
  const authDate = Number(params.get("auth_date") || 0);
  return { hash, dataCheckString, user, authDate };
}

function hmacHex(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

let warnedUnverifiedInitData = false;

function isProductionEnv() {
  return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
}

// Startup check: without TELEGRAM_BOT_TOKEN in production there is no way to
// verify the initData signature, so every Telegram identity is rejected below.
if (isProductionEnv() && !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error(
    "[telegram] TELEGRAM_BOT_TOKEN is not set in production — Telegram initData will be rejected",
  );
}

export function verifyTelegramInitData(initData: string): TelegramWebAppUser | null {
  if (!initData || initData.length < 16 || initData.length > 4096) return null;
  const parsed = parseInitData(initData);
  if (!parsed.user?.id || !Number.isFinite(parsed.user.id)) return null;
  if (parsed.authDate) {
    const age = Date.now() / 1000 - parsed.authDate;
    if (age > 86400 * 2) return null;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (token) {
    if (!parsed.hash) return null;
    const secret = hmacHex("WebAppData", token);
    const digest = hmacHex(secret, parsed.dataCheckString);
    let given: Buffer;
    try {
      given = Buffer.from(parsed.hash, "hex");
    } catch {
      return null;
    }
    if (given.length !== digest.length || !timingSafeEqual(given, digest)) return null;
    return parsed.user;
  }

  // No bot token: in production a well-formed initData is not enough — reject.
  if (isProductionEnv()) return null;

  // Dev/preview only: accept well-formed initData from the WebApp.
  if (!parsed.hash || !parsed.authDate) return null;
  if (!warnedUnverifiedInitData) {
    warnedUnverifiedInitData = true;
    console.warn(
      "[telegram] TELEGRAM_BOT_TOKEN is not set — accepting Telegram initData WITHOUT signature verification (dev/preview only)",
    );
  }
  return parsed.user;
}

export function telegramUserId(user: TelegramWebAppUser) {
  return `tg:${user.id}`;
}

export function telegramDisplayName(user: TelegramWebAppUser) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || `id${user.id}`;
}
