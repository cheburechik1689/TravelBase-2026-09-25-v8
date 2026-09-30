import type { VerifiedUser } from "@/lib/auth/verify.server";
import { telegramDisplayName, telegramUserId, verifyTelegramInitData } from "./telegram";
import { upsertTelegramProfile } from "./store";

async function fromTelegram(request: Request): Promise<VerifiedUser | null> {
  const initData =
    request.headers.get("x-telegram-init-data") ||
    request.headers.get("X-Telegram-Init-Data") ||
    "";
  if (!initData) return null;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return null;
  const id = telegramUserId(tgUser);
  try {
    await upsertTelegramProfile(id, String(tgUser.id), telegramDisplayName(tgUser));
  } catch {
    /* profile table may still be migrating */
  }
  return { id, email: tgUser.username ? `${tgUser.username}@telegram.local` : null };
}

export async function optionalUser(request: Request): Promise<VerifiedUser | null> {
  try {
    const { getSessionUser } = await import("@/lib/auth/verify.server");
    const header = request.headers.get("authorization") || "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const session = await getSessionUser(bearer);
    if (session) return session;
  } catch {
    /* fall through to Telegram */
  }
  try {
    return await fromTelegram(request);
  } catch {
    return null;
  }
}

export async function requireUser(request: Request): Promise<VerifiedUser | Response> {
  const user = await optionalUser(request);
  if (!user) {
    return Response.json(
      { success: false, error: "Unauthorized", message: "Нужно войти в кабинет" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return user;
}

export function isUnauthorized(value: VerifiedUser | Response): value is Response {
  return value instanceof Response;
}
