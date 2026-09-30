/**
 * In-memory sliding-window rate limiter for expensive endpoints.
 *
 * State lives in one process and never leaves this module: callers get a
 * `checkRateLimit` verdict and a ready-made 429 response. To move to Redis
 * later, reimplement this file behind the same exports — handlers stay put.
 */

const WINDOW_MS = 10 * 60 * 1000;

const LIMITS = {
  generate: 10,
  "knowledge-suggest": 20,
} as const;

export type RateLimitScope = keyof typeof LIMITS;

export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, stamps] of hits) {
    const fresh = stamps.filter((ts) => now - ts < WINDOW_MS);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}

/**
 * Record a hit for `scope`+`key` and report whether it fits the limit.
 * `now` is injectable for tests.
 */
export function checkRateLimit(
  scope: RateLimitScope,
  key: string,
  now = Date.now(),
): RateLimitVerdict {
  sweep(now);
  const mapKey = `${scope}:${key}`;
  const stamps = (hits.get(mapKey) || []).filter((ts) => now - ts < WINDOW_MS);
  const limit = LIMITS[scope];
  if (stamps.length >= limit) {
    hits.set(mapKey, stamps);
    const oldest = stamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  stamps.push(now);
  hits.set(mapKey, stamps);
  return { ok: true };
}

/** Stable caller key: user id when signed in, otherwise client IP. */
export function rateLimitKey(request: Request, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = (forwarded ? forwarded.split(",")[0].trim() : "") || request.headers.get("x-real-ip") || "";
  return ip ? `ip:${ip}` : "ip:unknown";
}

/** Ready 429 response with Retry-After, matching the API's JSON shape. */
export function rateLimitResponse(retryAfterSec: number): Response {
  return Response.json(
    { success: false, error: "Слишком много запросов, подождите пару минут" },
    {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSec) },
    },
  );
}
