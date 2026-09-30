import { fetchJson, UA } from "./http";
import { geoCacheGet, geoCacheSet } from "./geo-cache";

export type GeoPoint = { lat: number; lon: number; address?: string; name?: string };

type PhotonFeature = {
  geometry?: { coordinates?: number[] };
  properties?: { name?: string; city?: string; country?: string; street?: string };
};

export async function photonGeocode(
  query: string,
  bias?: { lat?: number | null; lon?: number | null },
): Promise<GeoPoint | null> {
  const hits = await photonSearch(query, bias, 1);
  return hits[0] || null;
}

export async function photonSearch(
  query: string,
  bias?: { lat?: number | null; lon?: number | null },
  limit = 5,
): Promise<GeoPoint[]> {
  const cacheKey =
    `photon:${query.toLowerCase().trim()}|` +
    `${bias?.lat != null ? bias.lat.toFixed(2) : ""},${bias?.lon != null ? bias.lon.toFixed(2) : ""}|` +
    Math.max(1, Math.min(10, limit));
  const cached = await geoCacheGet<GeoPoint[]>(cacheKey);
  if (cached && cached.length > 0) return cached;
  const out = await photonSearchLookup(query, bias, limit);
  if (out.length > 0) await geoCacheSet(cacheKey, "photon", out);
  return out;
}

async function photonSearchLookup(
  query: string,
  bias?: { lat?: number | null; lon?: number | null },
  limit = 5,
): Promise<GeoPoint[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.max(1, Math.min(10, limit))));
  if (bias?.lat != null && bias?.lon != null) {
    url.searchParams.set("lat", String(bias.lat));
    url.searchParams.set("lon", String(bias.lon));
  }
  try {
    const data = (await fetchJson(url.toString(), {}, 6000)) as {
      features?: PhotonFeature[];
    };
    const out: GeoPoint[] = [];
    for (const f of data.features || []) {
      const coords = f?.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      const [lon, lat] = coords;
      const p = f?.properties || {};
      out.push({
        lat,
        lon,
        address: [p.name, p.street, p.city, p.country].filter(Boolean).join(", "),
        name: p.name,
      });
    }
    return out;
  } catch {
    return [];
  }
}

type NominatimHit = {
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  address?: Record<string, string>;
};

export async function nominatimGeocode(query: string): Promise<GeoPoint | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "ru,en");
  try {
    const data = (await fetchJson(url.toString(), {}, 7000)) as NominatimHit[];
    const hit = data?.[0];
    if (!hit?.lat || !hit?.lon) return null;
    return {
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      address: hit.display_name,
      name: hit.name,
    };
  } catch {
    return null;
  }
}

const CITY_HINTS: Record<string, GeoPoint> = {
  париж: { lat: 48.8566, lon: 2.3522, name: "Paris", address: "Paris, France" },
  paris: { lat: 48.8566, lon: 2.3522, name: "Paris", address: "Paris, France" },
  рим: { lat: 41.9028, lon: 12.4964, name: "Rome", address: "Rome, Italy" },
  rome: { lat: 41.9028, lon: 12.4964, name: "Rome", address: "Rome, Italy" },
  стамбул: { lat: 41.0082, lon: 28.9784, name: "Istanbul", address: "Istanbul, Turkey" },
  istanbul: { lat: 41.0082, lon: 28.9784, name: "Istanbul", address: "Istanbul, Turkey" },
  барселона: { lat: 41.3874, lon: 2.1686, name: "Barcelona", address: "Barcelona, Spain" },
  barcelona: { lat: 41.3874, lon: 2.1686, name: "Barcelona", address: "Barcelona, Spain" },
  дубай: { lat: 25.2048, lon: 55.2708, name: "Dubai", address: "Dubai, UAE" },
  dubai: { lat: 25.2048, lon: 55.2708, name: "Dubai", address: "Dubai, UAE" },
  лондон: { lat: 51.5074, lon: -0.1278, name: "London", address: "London, UK" },
  london: { lat: 51.5074, lon: -0.1278, name: "London", address: "London, UK" },
  токио: { lat: 35.6762, lon: 139.6503, name: "Tokyo", address: "Tokyo, Japan" },
  tokyo: { lat: 35.6762, lon: 139.6503, name: "Tokyo", address: "Tokyo, Japan" },
  бангкок: { lat: 13.7563, lon: 100.5018, name: "Bangkok", address: "Bangkok, Thailand" },
  bangkok: { lat: 13.7563, lon: 100.5018, name: "Bangkok", address: "Bangkok, Thailand" },
  "нью-йорк": { lat: 40.7128, lon: -74.006, name: "New York", address: "New York, USA" },
  "new york": { lat: 40.7128, lon: -74.006, name: "New York", address: "New York, USA" },
  бали: { lat: -8.4095, lon: 115.1889, name: "Bali", address: "Bali, Indonesia" },
  bali: { lat: -8.4095, lon: 115.1889, name: "Bali", address: "Bali, Indonesia" },
  прага: { lat: 50.0755, lon: 14.4378, name: "Prague", address: "Prague, Czechia" },
  prague: { lat: 50.0755, lon: 14.4378, name: "Prague", address: "Prague, Czechia" },
  берлин: { lat: 52.52, lon: 13.405, name: "Berlin", address: "Berlin, Germany" },
  berlin: { lat: 52.52, lon: 13.405, name: "Berlin", address: "Berlin, Germany" },
  амстердам: { lat: 52.3676, lon: 4.9041, name: "Amsterdam", address: "Amsterdam, Netherlands" },
  amsterdam: { lat: 52.3676, lon: 4.9041, name: "Amsterdam", address: "Amsterdam, Netherlands" },
  лиссабон: { lat: 38.7223, lon: -9.1393, name: "Lisbon", address: "Lisbon, Portugal" },
  lisbon: { lat: 38.7223, lon: -9.1393, name: "Lisbon", address: "Lisbon, Portugal" },
  москва: { lat: 55.7558, lon: 37.6173, name: "Moscow", address: "Moscow, Russia" },
  moscow: { lat: 55.7558, lon: 37.6173, name: "Moscow", address: "Moscow, Russia" },
  "санкт-петербург": { lat: 59.9311, lon: 30.3609, name: "Saint Petersburg", address: "Saint Petersburg, Russia" },
  петербург: { lat: 59.9311, lon: 30.3609, name: "Saint Petersburg", address: "Saint Petersburg, Russia" },
  "saint petersburg": { lat: 59.9311, lon: 30.3609, name: "Saint Petersburg", address: "Saint Petersburg, Russia" },
  тбилиси: { lat: 41.7151, lon: 44.8271, name: "Tbilisi", address: "Tbilisi, Georgia" },
  tbilisi: { lat: 41.7151, lon: 44.8271, name: "Tbilisi", address: "Tbilisi, Georgia" },
  ереван: { lat: 40.1792, lon: 44.4991, name: "Yerevan", address: "Yerevan, Armenia" },
  yerevan: { lat: 40.1792, lon: 44.4991, name: "Yerevan", address: "Yerevan, Armenia" },
  сочи: { lat: 43.5855, lon: 39.7231, name: "Sochi", address: "Sochi, Russia" },
  sochi: { lat: 43.5855, lon: 39.7231, name: "Sochi", address: "Sochi, Russia" },
  казань: { lat: 55.7887, lon: 49.1221, name: "Kazan", address: "Kazan, Russia" },
  kazan: { lat: 55.7887, lon: 49.1221, name: "Kazan", address: "Kazan, Russia" },
  калининград: { lat: 54.7104, lon: 20.4522, name: "Kaliningrad", address: "Kaliningrad, Russia" },
  иркутск: { lat: 52.2869, lon: 104.305, name: "Irkutsk", address: "Irkutsk, Russia" },
  байкал: { lat: 51.905, lon: 104.86, name: "Baikal", address: "Lake Baikal, Russia" },
  суздаль: { lat: 56.4213, lon: 40.4489, name: "Suzdal", address: "Suzdal, Russia" },
  владимир: { lat: 56.129, lon: 40.4066, name: "Vladimir", address: "Vladimir, Russia" },
  ярославль: { lat: 57.6266, lon: 39.8938, name: "Yaroslavl", address: "Yaroslavl, Russia" },
  алтай: { lat: 51.9581, lon: 85.9603, name: "Gorno-Altaysk", address: "Altai, Russia" },
  "горно-алтайск": { lat: 51.9581, lon: 85.9603, name: "Gorno-Altaysk", address: "Altai, Russia" },
  камчатка: { lat: 53.037, lon: 158.6559, name: "Petropavlovsk-Kamchatsky", address: "Kamchatka, Russia" },
  "петропавловск-камчатский": { lat: 53.037, lon: 158.6559, name: "Petropavlovsk-Kamchatsky", address: "Kamchatka, Russia" },
  дагестан: { lat: 42.0576, lon: 48.288, name: "Derbent", address: "Dagestan, Russia" },
  дербент: { lat: 42.0576, lon: 48.288, name: "Derbent", address: "Derbent, Russia" },
  махачкала: { lat: 42.9849, lon: 47.5047, name: "Makhachkala", address: "Makhachkala, Russia" },
  карелия: { lat: 61.7849, lon: 34.3469, name: "Petrozavodsk", address: "Karelia, Russia" },
  петрозаводск: { lat: 61.7849, lon: 34.3469, name: "Petrozavodsk", address: "Petrozavodsk, Russia" },
  мурманск: { lat: 68.9585, lon: 33.0827, name: "Murmansk", address: "Murmansk, Russia" },
  владивосток: { lat: 43.1155, lon: 131.8855, name: "Vladivostok", address: "Vladivostok, Russia" },
};

export function normalizePlaceKey(place: string): string {
  return place
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(",")[0]
    .trim();
}

export function cityHintFor(place: string): GeoPoint | null {
  return CITY_HINTS[normalizePlaceKey(place)] || null;
}

export function latinCityName(place: string): string {
  return cityHintFor(place)?.name || place.split(",")[0].trim();
}

export async function geocodePlace(input: {
  place: string;
  destination?: string;
  destLat?: number | null;
  destLon?: number | null;
}): Promise<GeoPoint | null> {
  const place = input.place.trim();
  if (!place) return null;
  const placeHint = cityHintFor(place);
  if (placeHint) return placeHint;
  const cacheKey = `geocode:${normalizePlaceKey(place)}|${normalizePlaceKey(input.destination || "")}`;
  const cached = await geoCacheGet<GeoPoint>(cacheKey);
  if (cached) return cached;
  const result = await geocodePlaceLookup(input);
  if (result) await geoCacheSet(cacheKey, "geocode", result);
  return result;
}

async function geocodePlaceLookup(input: {
  place: string;
  destination?: string;
  destLat?: number | null;
  destLon?: number | null;
}): Promise<GeoPoint | null> {
  const place = input.place.trim();
  const dest = (input.destination || "").trim();
  const queries = dest ? [place, `${place}, ${dest}`, dest] : [place];
  for (const q of queries) {
    const photon = await photonGeocode(q, { lat: input.destLat, lon: input.destLon });
    if (photon && nearDest(photon, input.destLat, input.destLon)) return photon;
  }
  for (const q of queries.slice(0, 2)) {
    const nom = await nominatimGeocode(q);
    if (nom && nearDest(nom, input.destLat, input.destLon)) return nom;
  }
  return null;
}

function nearDest(pt: GeoPoint, lat?: number | null, lon?: number | null) {
  if (lat == null || lon == null) return true;
  const dlat = pt.lat - lat;
  const dlon = pt.lon - lon;
  return Math.sqrt(dlat * dlat + dlon * dlon) < 1.5;
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeoPoint | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("accept-language", "ru,en");
  try {
    const item = (await fetchJson(url.toString(), {}, 7000)) as NominatimHit;
    const addr = item.address || {};
    const name =
      item.name ||
      addr.attraction ||
      addr.tourism ||
      addr.historic ||
      addr.amenity ||
      addr.road ||
      (item.display_name || "").split(",").slice(0, 2).join(",").trim();
    return {
      lat: Number(item.lat || lat),
      lon: Number(item.lon || lon),
      address: item.display_name,
      name: name || item.display_name,
    };
  } catch {
    return null;
  }
}

/**
 * Название района/квартала по координатам (Nominatim reverse, zoom=16).
 * Кэшируется в geo_cache — повторные маршруты по городу не ходят в сеть.
 * null при любой ошибке: вызывающий код подставляет fallback.
 */
export async function districtName(lat: number, lon: number): Promise<string | null> {
  const cacheKey = `district:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = await geoCacheGet<string>(cacheKey);
  if (cached) return cached;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "16");
  url.searchParams.set("accept-language", "ru,en");
  try {
    const item = (await fetchJson(url.toString(), {}, 7000)) as {
      address?: Record<string, string>;
    };
    const a = item.address || {};
    const name =
      a.suburb || a.city_district || a.neighbourhood || a.quarter || a.borough || null;
    if (name) await geoCacheSet(cacheKey, "district", name);
    return name;
  } catch {
    return null;
  }
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function optimizeOrder<T extends { lat: number; lon: number }>(places: T[]): T[] {
  if (places.length <= 2) return places.slice();
  const n = places.length;
  const visited = new Array(n).fill(false);
  const route = [0];
  visited[0] = true;
  for (let step = 1; step < n; step++) {
    const last = route[route.length - 1];
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const d = haversineM(places[last].lat, places[last].lon, places[i].lat, places[i].lon);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      visited[bestIdx] = true;
      route.push(bestIdx);
    }
  }

  const distOf = (r: number[]) => {
    let sum = 0;
    for (let i = 0; i < r.length - 1; i++) {
      sum += haversineM(places[r[i]].lat, places[r[i]].lon, places[r[i + 1]].lat, places[r[i + 1]].lon);
    }
    return sum;
  };

  let improved = true;
  let maxIter = 80;
  while (improved && maxIter-- > 0) {
    improved = false;
    for (let i = 1; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const next = route.slice();
        let left = i;
        let right = j;
        while (left < right) {
          const tmp = next[left];
          next[left] = next[right];
          next[right] = tmp;
          left++;
          right--;
        }
        if (distOf(next) + 1 < distOf(route)) {
          route.splice(0, route.length, ...next);
          improved = true;
        }
      }
    }
  }
  return route.map((i) => places[i]);
}

export async function osrmRoute(
  points: { lat: number; lon: number }[],
  profile = "foot",
): Promise<{ geometry: { coordinates: number[][] }; distance: number; duration: number } | null> {
  if (points.length < 2) return null;
  const path = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/${profile === "car" ? "driving" : "foot"}/${path}?overview=full&geometries=geojson`;
  try {
    const data = (await fetchJson(url, {}, 10000)) as {
      routes?: {
        geometry?: { coordinates?: number[][] };
        distance?: number;
        duration?: number;
      }[];
    };
    const route = data.routes?.[0];
    if (!route?.geometry?.coordinates) return null;
    return {
      geometry: { coordinates: route.geometry.coordinates },
      distance: route.distance || 0,
      duration: route.duration || 0,
    };
  } catch {
    return null;
  }
}

const WMO_EMOJI: Record<number, string> = {
  0: "☀️",
  1: "🌤",
  2: "⛅",
  3: "☁️",
  45: "🌫",
  48: "🌫",
  51: "🌦",
  53: "🌦",
  55: "🌧",
  61: "🌧",
  63: "🌧",
  65: "⛈",
  71: "🌨",
  73: "🌨",
  75: "❄️",
  80: "🌦",
  81: "🌧",
  82: "⛈",
  95: "⛈",
  96: "⛈",
  99: "⛈",
};

export async function getWeather(input: {
  lat: number;
  lon: number;
  dateStart?: string;
  dateEnd?: string;
}): Promise<{
  days: { date: string; temp_max: number | null; temp_min: number | null; emoji: string }[];
  type: "forecast" | "historical";
}> {
  const start = input.dateStart ? Date.parse(input.dateStart) : NaN;
  const end = input.dateEnd ? Date.parse(input.dateEnd) : NaN;
  const now = Date.now();
  const useArchive = Number.isFinite(start) && start < now - 2 * 86400000;
  const params = new URLSearchParams({
    latitude: String(input.lat),
    longitude: String(input.lon),
    daily: "weathercode,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
  });
  if (Number.isFinite(start) && Number.isFinite(end)) {
    params.set("start_date", new Date(start).toISOString().slice(0, 10));
    params.set("end_date", new Date(end).toISOString().slice(0, 10));
  }
  const host = useArchive ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  try {
    const data = (await fetchJson(`${host}?${params.toString()}`, {}, 8000)) as {
      daily?: {
        time?: string[];
        weathercode?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
      };
    };
    const times = data.daily?.time || [];
    const days = times.map((date, i) => {
      const code = data.daily?.weathercode?.[i] ?? 1;
      return {
        date,
        temp_max: data.daily?.temperature_2m_max?.[i] ?? null,
        temp_min: data.daily?.temperature_2m_min?.[i] ?? null,
        emoji: WMO_EMOJI[code] || "🌤",
      };
    });
    return { days, type: useArchive ? "historical" : "forecast" };
  } catch {
    return { days: [], type: "forecast" };
  }
}

export async function wikipediaPhoto(place: string, destination?: string): Promise<string | null> {
  const q = [place, destination].filter(Boolean).join(" ").trim();
  if (!q) return null;
  for (const lang of ["ru", "en"]) {
    try {
      const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("format", "json");
      url.searchParams.set("origin", "*");
      url.searchParams.set("generator", "search");
      url.searchParams.set("gsrsearch", q);
      url.searchParams.set("gsrlimit", "1");
      url.searchParams.set("prop", "pageimages");
      url.searchParams.set("pithumbsize", "640");
      const data = (await fetchJson(url.toString(), { headers: { "User-Agent": UA } }, 6000)) as {
        query?: { pages?: Record<string, { thumbnail?: { source?: string } }> };
      };
      const page = Object.values(data.query?.pages || {})[0];
      if (page?.thumbnail?.source) return page.thumbnail.source;
    } catch {
      /* next lang */
    }
  }
  return null;
}

type OverpassEl = {
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

export async function nearbyPois(
  bbox: number[],
  limit = 80,
): Promise<{ name: string; lat: number; lon: number; kind: string }[]> {
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:6];(
    node["tourism"~"attraction|museum|gallery|viewpoint"](${s},${w},${n},${e});
    node["historic"~"monument|memorial|castle|church"](${s},${w},${n},${e});
  );out body ${Math.min(120, limit)};`;
  try {
    const data = (await fetchJson(
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: `data=${encodeURIComponent(q)}`,
      },
      8000,
    )) as { elements?: OverpassEl[] };
    const seen = new Set<string>();
    const out: { name: string; lat: number; lon: number; kind: string }[] = [];
    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const name = (el.tags?.name || el.tags?.["name:ru"] || el.tags?.["name:en"] || "").trim();
      if (lat == null || lon == null || name.length < 2) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: name.slice(0, 120),
        lat,
        lon,
        kind: el.tags?.tourism || el.tags?.historic || "poi",
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export type PlaceInfo = {
  extract: string | null;
  photos: string[];
  address: string | null;
  pageUrl: string | null;
};

export async function wikipediaPlaceInfo(place: string, destination?: string): Promise<PlaceInfo | null> {
  const q = [place, destination].filter(Boolean).join(" ").trim();
  if (!q) return null;
  for (const lang of ["ru", "en"]) {
    try {
      const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("format", "json");
      url.searchParams.set("origin", "*");
      url.searchParams.set("generator", "search");
      url.searchParams.set("gsrsearch", q);
      url.searchParams.set("gsrlimit", "1");
      url.searchParams.set("prop", "extracts|pageimages|info");
      url.searchParams.set("exintro", "1");
      url.searchParams.set("explaintext", "1");
      url.searchParams.set("exchars", "900");
      url.searchParams.set("pithumbsize", "800");
      url.searchParams.set("inprop", "url");
      const data = (await fetchJson(url.toString(), { headers: { "User-Agent": UA } }, 4000)) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              extract?: string;
              fullurl?: string;
              thumbnail?: { source?: string };
            }
          >;
        };
      };
      const page = Object.values(data.query?.pages || {})[0];
      if (!page) continue;
      const photos: string[] = [];
      if (page.thumbnail?.source) photos.push(page.thumbnail.source);
      // Добираем фото с Викисклада по названию статьи
      if (page.title) {
        try {
          const cu = new URL("https://commons.wikimedia.org/w/api.php");
          cu.searchParams.set("action", "query");
          cu.searchParams.set("format", "json");
          cu.searchParams.set("origin", "*");
          cu.searchParams.set("generator", "search");
          cu.searchParams.set("gsrsearch", `File: ${page.title}`);
          cu.searchParams.set("gsrnamespace", "6");
          cu.searchParams.set("gsrlimit", "8");
          cu.searchParams.set("prop", "imageinfo");
          cu.searchParams.set("iiurlwidth", "800");
          const cd = (await fetchJson(cu.toString(), { headers: { "User-Agent": UA } }, 4000)) as {
            query?: { pages?: Record<string, { imageinfo?: { thumburl?: string; url?: string }[] }> };
          };
          for (const cp of Object.values(cd.query?.pages || {})) {
            const ii = cp.imageinfo?.[0];
            const u = ii?.thumburl || ii?.url;
            if (u && !photos.includes(u)) photos.push(u);
            if (photos.length >= 8) break;
          }
        } catch {
          /* commons недоступен — идём дальше */
        }
      }
      return {
        extract: page.extract?.trim() || null,
        photos: photos.slice(0, 8),
        address: destination || null,
        pageUrl: page.fullurl || null,
      };
    } catch {
      /* next lang */
    }
  }
  return null;
}
