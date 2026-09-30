import { fetchJson, UA } from "./http";
import { districtName, haversineM, latinCityName, optimizeOrder, photonSearch } from "./geo";
import { geoCacheGet, geoCacheSet } from "./geo-cache";
import { kbFactsForCity, kbPlacesForCity, type KbPlaceRow } from "./kb";
import { seedLandmarks } from "./landmarks";
import { destinationKey } from "./security";
import type { PlanJson, Place } from "./plan-schema";

export type CatalogPoi = {
  name: string;
  lat: number;
  lon: number;
  kind: string;
  address?: string;
  food?: boolean;
  priority?: number;
  // Данные из базы знаний (kb_places), когда место нашлось там:
  description?: string;
  priceHint?: string;
  seasonHint?: string;
  kb?: boolean;
};

const FOOD_KINDS = new Set(["cafe", "restaurant", "fast_food", "marketplace", "bar"]);

type OverpassEl = {
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

const OVERPASS_URLS: { url: string; timeout: number }[] = [
  { url: "https://overpass-api.de/api/interpreter", timeout: 4500 },
  { url: "https://overpass.kumi.systems/api/interpreter", timeout: 4000 },
  { url: "https://overpass.osm.ch/api/interpreter", timeout: 4000 },
];

async function overpassCatalog(lat: number, lon: number): Promise<CatalogPoi[]> {
  const d = 0.032;
  const s = lat - d;
  const n = lat + d;
  const w = lon - d;
  const e = lon + d;
  const q = `[out:json][timeout:6];(
    node["tourism"~"attraction|museum|gallery|viewpoint|artwork"](${s},${w},${n},${e});
    node["historic"~"monument|memorial|castle|church|ruins"](${s},${w},${n},${e});
    node["amenity"~"cafe|restaurant|marketplace"](${s},${w},${n},${e});
    way["tourism"~"attraction|museum|gallery"](${s},${w},${n},${e});
  );out center 90;`;
  for (const mirror of OVERPASS_URLS) {
    try {
      const data = (await fetchJson(
        mirror.url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
          body: `data=${encodeURIComponent(q)}`,
        },
        mirror.timeout,
      )) as { elements?: OverpassEl[] };
      const seen = new Set<string>();
      const out: CatalogPoi[] = [];
      for (const el of data.elements || []) {
        const plat = el.lat ?? el.center?.lat;
        const plon = el.lon ?? el.center?.lon;
        const name = (el.tags?.name || el.tags?.["name:ru"] || el.tags?.["name:en"] || "").trim();
        if (plat == null || plon == null || name.length < 2) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = el.tags?.tourism || el.tags?.historic || el.tags?.amenity || "poi";
        out.push({
          name: name.slice(0, 120),
          lat: plat,
          lon: plon,
          kind,
          address: [el.tags?.["addr:street"], el.tags?.["addr:housenumber"], el.tags?.["addr:city"]]
            .filter(Boolean)
            .join(", "),
          food: FOOD_KINDS.has(kind),
        });
      }
      if (out.length) return out;
    } catch {
      /* try next mirror */
    }
  }
  return [];
}

async function photonFallback(city: string, lat: number, lon: number): Promise<CatalogPoi[]> {
  const cityEn = latinCityName(city);
  const queries = [
    `museum ${cityEn}`,
    `cathedral ${cityEn}`,
    `old town ${cityEn}`,
    `park ${cityEn}`,
    `market ${cityEn}`,
    `palace ${cityEn}`,
    `bridge ${cityEn}`,
  ];
  const out: CatalogPoi[] = [];
  const seen = new Set<string>();
  await Promise.all(
    queries.map(async (q) => {
      const hits = await photonSearch(q, { lat, lon }, 6);
      for (const hit of hits) {
        const name = (hit.name || hit.address || "").split(",")[0].trim();
        if (name.length < 2 || seen.has(name.toLowerCase())) continue;
        if (haversineM(lat, lon, hit.lat, hit.lon) > 6000) continue;
        seen.add(name.toLowerCase());
        const food = /market|рынк|cafe|ресторан/i.test(q);
        out.push({
          name: name.slice(0, 120),
          lat: hit.lat,
          lon: hit.lon,
          kind: food ? "marketplace" : "attraction",
          address: hit.address,
          food,
        });
      }
    }),
  );
  return out;
}

export async function catalogForCity(opts: {
  city: string;
  lat: number;
  lon: number;
  destKey?: string;
}): Promise<CatalogPoi[]> {
  const cacheKey = `catalog:${opts.lat.toFixed(2)}:${opts.lon.toFixed(2)}`;
  const cached = await geoCacheGet<CatalogPoi[]>(cacheKey);
  if (cached && cached.length > 0) return cached;
  const merged = await catalogForCityLookup(opts);
  if (merged.length > 0) await geoCacheSet(cacheKey, "catalog", merged);
  return merged;
}

async function catalogForCityLookup(opts: {
  city: string;
  lat: number;
  lon: number;
  destKey?: string;
}): Promise<CatalogPoi[]> {
  const cityEn = latinCityName(opts.city);
  const [overpass, photon] = await Promise.all([
    overpassCatalog(opts.lat, opts.lon),
    photonFallback(cityEn, opts.lat, opts.lon),
  ]);
  const seeds = seedLandmarks(opts.city);
  const merged: CatalogPoi[] = [];
  const seen = new Set<string>();
  for (const p of [...overpass, ...photon]) {
    if (haversineM(opts.lat, opts.lon, p.lat, p.lon) >= 7000) continue;
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  for (const p of seeds) {
    if (haversineM(opts.lat, opts.lon, p.lat, p.lon) >= 28000) continue;
    const key = p.name.toLowerCase();
    if (seen.has(key)) {
      const hit = merged.find((x) => x.name.toLowerCase() === key);
      if (hit) hit.priority = Math.max(hit.priority || 0, 8);
      continue;
    }
    seen.add(key);
    merged.push({ ...p, priority: 8 });
  }
  // База знаний: обогащает совпавшие POI и добавляет уникальные места.
  const kbPlaces = await kbPlacesForCity(opts.destKey ?? opts.city);
  if (kbPlaces.length) mergeKbPlaces(merged, kbPlaces);
  return merged.filter((p) => !isWeakPoi(p)).slice(0, 80);
}

/**
 * Мёрдж kb_places в каталог: совпадение по нормализованному имени или близости
 * (≤ 300 м) переносит description/price_hint/season_hint и даёт +5 priority;
 * уникальные места базы (с координатами) добавляются с priority от score.
 */
function mergeKbPlaces(merged: CatalogPoi[], kbPlaces: KbPlaceRow[]) {
  for (const kb of kbPlaces) {
    const norm = destinationKey(kb.name);
    if (!norm) continue;
    let hit = merged.find((p) => destinationKey(p.name) === norm);
    if (!hit && kb.lat != null && kb.lon != null) {
      // Только ещё не обогащённые POI — иначе в плотном центре несколько мест
      // базы знаний прилипнут к одной ближайшей точке.
      hit = merged.find((p) => !p.kb && haversineM(p.lat, p.lon, kb.lat!, kb.lon!) <= 300);
    }
    if (hit) {
      hit.description = hit.description || kb.description || undefined;
      hit.priceHint = hit.priceHint || kb.price_hint || undefined;
      hit.seasonHint = hit.seasonHint || kb.season_hint || undefined;
      hit.priority = (hit.priority || 0) + 5;
      hit.kb = true;
      continue;
    }
    if (kb.lat == null || kb.lon == null) continue; // без координат на маршрут не поставить
    merged.push({
      name: kb.name,
      lat: kb.lat,
      lon: kb.lon,
      kind: kb.kind || "attraction",
      description: kb.description || undefined,
      priceHint: kb.price_hint || undefined,
      seasonHint: kb.season_hint || undefined,
      priority: Math.min(10, Math.max(1, Math.round(kb.score || 1))),
      kb: true,
    });
  }
}

function isWeakPoi(p: CatalogPoi) {
  const n = p.name.toLowerCase();
  if (n.length < 4) return true;
  if (p.priority && p.priority >= 5) return false;
  if (/\b(hotel|hyatt|ibis|novotel|marriott|hilton|hostel|motel|mercure|radisson)\b/i.test(p.name)) return true;
  if (/\b(media market|ikea|mcdonald|starbucks|kfc|supermarket)\b/i.test(n)) return true;
  if (/^(market|park|bridge|palace|museum|cathedral)\s+\S+$/i.test(n)) return true;
  if (/^(skate park|parking|toilet|unnamed|park$)/i.test(n)) return true;
  return false;
}

function kindScore(p: CatalogPoi, theme: string) {
  const t = theme.toLowerCase();
  const kind = p.kind;
  let s = p.priority || 0;
  if (/museum|gallery|artwork/.test(kind)) s += t.includes("музей") ? 4 : 2;
  if (/attraction|viewpoint/.test(kind)) s += t.includes("популяр") ? 3 : 1;
  if (/historic|castle|church|monument/.test(kind)) s += t.includes("истор") ? 4 : 1;
  if (/park|garden/.test(kind)) s += t.includes("природ") ? 4 : 0;
  return s;
}

function describePoi(p: CatalogPoi, currency: string): string {
  // Описание из базы знаний важнее шаблона; шаблон — fallback.
  if (p.description) return p.description.slice(0, 300);
  if (p.food) return "Еда рядом с маршрутом — без лишних переездов. Берите блюдо дня.";
  if (p.kind === "museum" || p.kind === "gallery")
    return "Заложите запас на очередь и аудиогид. Онлайн-билет обычно окупается.";
  if (p.kind === "viewpoint") return "Лучше к золотому часу. 20 минут хватит на фото и вид.";
  if (p.kind === "marketplace") return "Живой рынок: еда, сувениры и ориентир по району.";
  return `Реальная точка на карте. Пешком от предыдущей — смотрите время. Цена уточняйте на месте, часто бесплатно или ~500 ${currency}.`;
}

function priceFor(p: CatalogPoi, currency: string) {
  // Цена из базы знаний важнее шаблона; шаблон — fallback.
  if (p.priceHint) return p.priceHint.slice(0, 120);
  if (p.food) return `~1800 ${currency}`;
  if (p.kind === "museum" || p.kind === "gallery") return `~1500 ${currency}`;
  if (p.kind === "viewpoint") return "бесплатно / смотровая";
  return "бесплатно";
}

const SLOTS: [string, string, number][] = [
  ["09:00", "10:20", 80],
  ["10:35", "12:00", 85],
  ["12:15", "13:30", 75],
  ["13:45", "15:15", 90],
  ["15:30", "17:00", 90],
  ["17:30", "19:30", 120],
];

export async function assembleFromCatalog(opts: {
  destination: string;
  country?: string;
  days: number;
  theme: string;
  currency: string;
  wishes: string;
  catalog: CatalogPoi[];
}): Promise<PlanJson | null> {
  const attractions = opts.catalog
    .filter((p) => !p.food)
    .sort((a, b) => kindScore(b, opts.theme) - kindScore(a, opts.theme));
  const food = opts.catalog.filter((p) => p.food);
  if (attractions.length < 3) return null;

  // База знаний активна для этого направления, если каталог получил KB-данные.
  // Пока KB пуста — поведение планировщика не меняется вообще.
  const kbActive = opts.catalog.some((p) => p.kb);
  const kbFacts = kbActive ? await kbFactsForCity(opts.destination, 4) : [];

  const unused = attractions.slice();
  const usedFood = new Set<string>();
  const days: PlanJson["days"] = [];
  let prev: CatalogPoi | null = null;

  for (let d = 0; d < opts.days; d++) {
    if (unused.length === 0) break;
    let seedIdx = 0;
    if (prev) {
      const ranked = unused.map((p, i) => {
        const dist = haversineM(prev!.lat, prev!.lon, p.lat, p.lon);
        const neighbors = unused.filter(
          (o, j) => j !== i && haversineM(p.lat, p.lon, o.lat, o.lon) < 3800,
        ).length;
        return { i, dist, neighbors, priority: p.priority || 0 };
      });
      ranked.sort((a, b) => {
        const ac = a.neighbors >= 2 ? 1 : 0;
        const bc = b.neighbors >= 2 ? 1 : 0;
        if (bc !== ac) return bc - ac;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.dist - a.dist;
      });
      seedIdx = ranked[0]?.i || 0;
    }
    const seed = unused.splice(seedIdx, 1)[0];
    const scored = unused.map((p, i) => ({
      p,
      i,
      dist: haversineM(seed.lat, seed.lon, p.lat, p.lon),
    }));
    let nearby = scored.filter((x) => x.dist < 2200).sort((a, b) => a.dist - b.dist).slice(0, 4);
    if (nearby.length < 2) {
      nearby = scored.filter((x) => x.dist < 3800).sort((a, b) => a.dist - b.dist).slice(0, 4);
    }
    for (const n of [...nearby].sort((a, b) => b.i - a.i)) unused.splice(n.i, 1);
    const eats = food
      .filter((f) => !usedFood.has(f.name))
      .map((f) => ({ f, dist: haversineM(seed.lat, seed.lon, f.lat, f.lon) }))
      .filter((x) => x.dist < 1400)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2)
      .map((x) => {
        usedFood.add(x.f.name);
        return x.f;
      });

    const mixed = optimizeOrder([...nearby.map((n) => n.p), seed, ...eats]);
    const wish = d === 0 && opts.wishes ? ` Учитываем: ${opts.wishes.slice(0, 80)}.` : "";
    const places: Place[] = mixed.slice(0, 6).map((p, i) => {
      const slot = SLOTS[Math.min(i, SLOTS.length - 1)];
      const walk =
        i === 0
          ? 0
          : Math.max(
              3,
              Math.round(haversineM(mixed[i - 1].lat, mixed[i - 1].lon, p.lat, p.lon) / 80),
            );
      return {
        name: p.name,
        address: p.address || opts.destination,
        timeStart: slot[0],
        timeEnd: slot[1],
        durationMin: slot[2],
        walkMinFromPrev: Math.min(90, walk),
        description: describePoi(p, opts.currency) + wish,
        price: priceFor(p, opts.currency),
        lat: p.lat,
        lon: p.lon,
        kind: p.kind,
      };
    });
    if (!places.length) continue;
    prev = mixed[0];
    const labels = ["Исторический центр", "Набережная и парки", "Богемный район", "Современный центр"];
    // Район дня — по реальной географии кластера (reverse-geocode центроида,
    // кэш в geo_cache); при пустой базе знаний или сбое — старые заглушки.
    let district = labels[d % labels.length];
    if (kbActive) {
      const clat = mixed.reduce((s, p) => s + p.lat, 0) / mixed.length;
      const clon = mixed.reduce((s, p) => s + p.lon, 0) / mixed.length;
      const real = await districtName(clat, clon).catch(() => null);
      if (real) district = real;
    }
    days.push({
      day: d + 1,
      district,
      places,
    });
  }

  if (!days.length) return null;

  const hotelPois = opts.catalog.filter((p) => /hotel|guest|hostel/i.test(p.kind)).slice(0, 3);
  return {
    destination: opts.destination,
    country: opts.country || "",
    theme: opts.theme,
    days,
    hotels:
      hotelPois.length > 0
        ? hotelPois.map((h) => ({
            name: h.name,
            area: h.address || "центр",
            pricePerNight: `~9000 ${opts.currency}/ночь`,
            note: "Рядом с первым днём маршрута.",
          }))
        : [
            {
              name: `Отель в центре ${opts.destination.split(",")[0]}`,
              area: "10–15 мин пешком до дня 1",
              pricePerNight: `~9000 ${opts.currency}/ночь`,
              note: "База рядом с первым кластером.",
            },
          ],
    dailyBudget: {
      food: `~4500 ${opts.currency}`,
      transport: `~600 ${opts.currency}`,
      tickets: `~1600 ${opts.currency}`,
      shopping: `~1200 ${opts.currency}`,
      lodging: `~9000 ${opts.currency}`,
      total: `~16900 ${opts.currency}`,
    },
    tips: kbFacts.length
      ? // Советы из базы знаний (kb_facts, топ по confidence); шаблоны — fallback.
        kbFacts.map((f) => ({
          category: (f.category || "факт").toUpperCase().slice(0, 40),
          text: f.text.slice(0, 400),
        }))
      : [
          { category: "КАРТА", text: "Маршрут собран по реальным точкам OSM. Не прыгайте между днями — каждый кластер пеший." },
          { category: "ТРАНСПОРТ", text: `В ${opts.destination.split(",")[0]} берите дневной проездной, такси внутри центра редко окупается.` },
          { category: "ВРЕМЯ", text: "К музеям — к открытию. Онлайн-билет экономит 40–90 минут." },
          { category: "ЕДА", text: "Если меню на шести языках у входа — туристическая ловушка." },
        ],
  };
}

export function pickAlternate(catalog: CatalogPoi[], avoid: string[], near?: { lat: number; lon: number }) {
  const blocked = new Set(avoid.map((s) => s.toLowerCase()));
  const pool = catalog.filter((p) => !blocked.has(p.name.toLowerCase()) && !p.food);
  if (!pool.length) return null;
  if (!near) return pool[0];
  return [...pool].sort(
    (a, b) => haversineM(near.lat, near.lon, a.lat, a.lon) - haversineM(near.lat, near.lon, b.lat, b.lon),
  )[0];
}