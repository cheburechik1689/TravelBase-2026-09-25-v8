/**
 * DB-backed cache for expensive external geo services (Nominatim, Overpass,
 * Photon). Entries live 7 days; expired rows are swept once per SWEEP_EVERY
 * writes. Every failure (DB down, migration pending, stub mode) degrades
 * silently to "no cache" — generation must never break because of the cache.
 */
import { getSql, type Sql } from "@/lib/db";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY = 100;

let writesSinceSweep = 0;

async function sweepExpired(sql: Sql) {
  writesSinceSweep += 1;
  if (writesSinceSweep < SWEEP_EVERY) return;
  writesSinceSweep = 0;
  await sql`delete from geo_cache where created_at < now() - interval '7 days'`;
}

/** Cached payload for `key`, or null when missing / expired / DB unavailable. */
export async function geoCacheGet<T>(key: string): Promise<T | null> {
  try {
    const sql = await getSql();
    const rows = await sql<{ payload: T; created_at: string | Date }>`
      select payload, created_at from geo_cache where cache_key = ${key}
    `;
    const row = rows[0];
    if (!row) return null;
    const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    if (Date.now() - created.getTime() > TTL_MS) return null;
    return row.payload;
  } catch (err) {
    console.warn("[geo-cache] get failed, treating cache as empty:", err);
    return null;
  }
}

/** Store `payload` under `key`. Failures are logged and swallowed. */
export async function geoCacheSet(key: string, kind: string, payload: unknown): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      insert into geo_cache (cache_key, kind, payload)
      values (${key}, ${kind}, ${JSON.stringify(payload)})
      on conflict (cache_key) do update
      set payload = excluded.payload, created_at = now()
    `;
    await sweepExpired(sql);
  } catch (err) {
    console.warn("[geo-cache] set failed, entry skipped:", err);
  }
}
