/**
 * Чтение базы знаний (kb_places / kb_facts), наполненной офлайн-контуром
 * (scripts/crawl-sources.mjs + scripts/extract-knowledge.mjs). Любой сбой БД
 * деградирует в «базы знаний нет» — генерация не должна от этого зависеть.
 */
import { getSql } from "@/lib/db";
import { destinationKey } from "./security";

export type KbPlaceRow = {
  id: string;
  name: string;
  kind: string | null;
  lat: number | null;
  lon: number | null;
  description: string | null;
  price_hint: string | null;
  season_hint: string | null;
  score: number | null;
};

/** Места по направлению (destinationKey от названия города), лучшие первыми. */
export async function kbPlacesForCity(city: string): Promise<KbPlaceRow[]> {
  try {
    const sql = await getSql();
    return await sql<KbPlaceRow>`
      select id, name, kind, lat, lon, description, price_hint, season_hint, score
      from kb_places
      where destination_key = ${destinationKey(city)}
      order by score desc
      limit 200
    `;
  } catch (err) {
    console.warn("[kb] places lookup failed:", err);
    return [];
  }
}

/** До `limit` направлений, покрытых базой знаний (есть места в kb_places). */
export async function kbCoveredDestinations(limit = 30): Promise<string[]> {
  try {
    const sql = await getSql();
    const rows = await sql<{ destination_key: string }>`
      select distinct destination_key from kb_places order by destination_key limit ${limit}
    `;
    return rows.map((r) => r.destination_key);
  } catch (err) {
    console.warn("[kb] covered destinations lookup failed:", err);
    return [];
  }
}

/** До `limit` фактов по направлению с наивысшим confidence. */
export async function kbFactsForCity(city: string, limit = 4) {
  try {
    const sql = await getSql();
    return await sql<{ category: string | null; text: string }>`
      select category, text
      from kb_facts
      where destination_key = ${destinationKey(city)}
      order by confidence desc
      limit ${limit}
    `;
  } catch (err) {
    console.warn("[kb] facts lookup failed:", err);
    return [];
  }
}
