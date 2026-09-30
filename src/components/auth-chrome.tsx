import { useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { hasGateSessionMarker } from "@/lib/auth/gate-session-marker";
import { isTelegramWebApp } from "@/lib/travelbase/tma";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

const subscribeToNothing = () => () => {};
const noGateOnServer = () => false;

function Chip({ compact = false, avatarOnly = false }: { compact?: boolean; avatarOnly?: boolean }) {
  const { user, isPending } = useCurrentUserState();
  const [signingOut, setSigningOut] = useState(false);
  const gateSession = useSyncExternalStore(
    subscribeToNothing,
    hasGateSessionMarker,
    noGateOnServer,
  );

  if (isPending) {
    return <div className="h-10 w-10 animate-pulse rounded-full bg-black/8" aria-hidden />;
  }

  if (!user) {
    // Внутри Telegram Mini App регистрация не нужна — ведём сразу в кабинет.
    return (
      <Link to="/cabinet" className="tb-avatar-btn" aria-label="Кабинет">
        <UserRound strokeWidth={2.2} />
      </Link>
    );
  }

  const label = user.displayName ?? user.primaryEmail ?? "Кабинет";
  const initial = label.charAt(0).toUpperCase();

  if (avatarOnly) {
    return (
      <Link to="/cabinet" className="tb-avatar-btn overflow-hidden p-0" aria-label="Кабинет">
        {user.profileImageUrl ? (
          <img src={user.profileImageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center bg-plum text-[13px] font-semibold text-cloud">
            {initial}
          </span>
        )}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        to="/cabinet"
        className="inline-flex h-8 max-w-[160px] items-center gap-2 rounded-full bg-black/5 px-2 pr-3 text-[12px] font-semibold text-ink no-underline"
      >
        {user.profileImageUrl ? (
          <img src={user.profileImageUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
        ) : (
          <span className="grid h-6 w-6 place-items-center rounded-full bg-plum text-[11px] text-cloud">
            {initial}
          </span>
        )}
        <span className="truncate">{compact ? "Кабинет" : label}</span>
      </Link>

    </div>
  );
}

export function AuthSlot({ compact = false }: { compact?: boolean }) {
  return <Chip compact={compact} />;
}

export function PlannerAuthPortal() {
  return (
    <div className="tb-planner-auth pointer-events-auto absolute top-[12px] right-4 z-50">
      <Chip compact avatarOnly />
    </div>
  );
}

export function installAuthFetch() {
  if (typeof window === "undefined") return;
  const w = window as Window & { __TB_AUTH_FETCH?: boolean };
  if (w.__TB_AUTH_FETCH) return;
  w.__TB_AUTH_FETCH = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    try {
      const token = window.sessionStorage.getItem("grok-auth.bearer-token");
      if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    } catch {
      /* ignore */
    }
    try {
      const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp
        ?.initData;
      if (tg && !headers.has("X-Telegram-Init-Data")) headers.set("X-Telegram-Init-Data", tg);
    } catch {
      /* ignore */
    }
    return orig(input, { ...init, headers, credentials: init?.credentials ?? "same-origin" });
  };
}
