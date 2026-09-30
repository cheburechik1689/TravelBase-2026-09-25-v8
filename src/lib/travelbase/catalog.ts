import { fetchJson, str } from "./http";

export const PRESET_POPULAR = [
  { emoji: "🇫🇷", city: "Париж", country: "Франция" },
  { emoji: "🇮🇹", city: "Рим", country: "Италия" },
  { emoji: "🇹🇷", city: "Стамбул", country: "Турция" },
  { emoji: "🇪🇸", city: "Барселона", country: "Испания" },
  { emoji: "🇦🇪", city: "Дубай", country: "ОАЭ" },
  { emoji: "🇬🇧", city: "Лондон", country: "Великобритания" },
  { emoji: "🇯🇵", city: "Токио", country: "Япония" },
  { emoji: "🇹🇭", city: "Бангкок", country: "Таиланд" },
  { emoji: "🇺🇸", city: "Нью-Йорк", country: "США" },
  { emoji: "🇮🇩", city: "Бали", country: "Индонезия" },
];

export const PRESET_RUSSIA = [
  { emoji: "🇷🇺", city: "Алтай", country: "Россия" },
  { emoji: "🇷🇺", city: "Камчатка", country: "Россия" },
  { emoji: "🇷🇺", city: "Дагестан", country: "Россия" },
  { emoji: "🇷🇺", city: "Суздаль", country: "Россия" },
  { emoji: "🇷🇺", city: "Казань", country: "Россия" },
  { emoji: "🇷🇺", city: "Сочи", country: "Россия" },
  { emoji: "🇷🇺", city: "Байкал", country: "Россия" },
  { emoji: "🇷🇺", city: "Карелия", country: "Россия" },
  { emoji: "🇷🇺", city: "Калининград", country: "Россия" },
  { emoji: "🇷🇺", city: "Санкт-Петербург", country: "Россия" },
];

const IATA_HINTS: Record<string, { code: string; name: string; country: string }> = {
  москва: { code: "MOW", name: "Moscow", country: "Russia" },
  "санкт-петербург": { code: "LED", name: "Saint Petersburg", country: "Russia" },
  петербург: { code: "LED", name: "Saint Petersburg", country: "Russia" },
  сочи: { code: "AER", name: "Sochi", country: "Russia" },
  казань: { code: "KZN", name: "Kazan", country: "Russia" },
  калининград: { code: "KGD", name: "Kaliningrad", country: "Russia" },
  иркутск: { code: "IKT", name: "Irkutsk", country: "Russia" },
  байкал: { code: "IKT", name: "Irkutsk", country: "Russia" },
  алтай: { code: "RGK", name: "Gorno-Altaysk", country: "Russia" },
  "горно-алтайск": { code: "RGK", name: "Gorno-Altaysk", country: "Russia" },
  камчатка: { code: "PKC", name: "Petropavlovsk-Kamchatsky", country: "Russia" },
  "петропавловск-камчатский": { code: "PKC", name: "Petropavlovsk-Kamchatsky", country: "Russia" },
  дагестан: { code: "MCX", name: "Makhachkala", country: "Russia" },
  дербент: { code: "MCX", name: "Makhachkala", country: "Russia" },
  махачкала: { code: "MCX", name: "Makhachkala", country: "Russia" },
  карелия: { code: "PES", name: "Petrozavodsk", country: "Russia" },
  петрозаводск: { code: "PES", name: "Petrozavodsk", country: "Russia" },
  мурманск: { code: "MMK", name: "Murmansk", country: "Russia" },
  владивосток: { code: "VVO", name: "Vladivostok", country: "Russia" },
  суздаль: { code: "IWA", name: "Ivanovo", country: "Russia" },
  владимир: { code: "IWA", name: "Ivanovo", country: "Russia" },
  ярославль: { code: "IAR", name: "Yaroslavl", country: "Russia" },
  париж: { code: "PAR", name: "Paris", country: "France" },
  рим: { code: "ROM", name: "Rome", country: "Italy" },
  стамбул: { code: "IST", name: "Istanbul", country: "Turkey" },
  барселона: { code: "BCN", name: "Barcelona", country: "Spain" },
  дубай: { code: "DXB", name: "Dubai", country: "United Arab Emirates" },
  лондон: { code: "LON", name: "London", country: "United Kingdom" },
  токио: { code: "TYO", name: "Tokyo", country: "Japan" },
  бангкок: { code: "BKK", name: "Bangkok", country: "Thailand" },
  "нью-йорк": { code: "NYC", name: "New York", country: "United States" },
  бали: { code: "DPS", name: "Denpasar", country: "Indonesia" },
  тбилиси: { code: "TBS", name: "Tbilisi", country: "Georgia" },
  ереван: { code: "EVN", name: "Yerevan", country: "Armenia" },
  прага: { code: "PRG", name: "Prague", country: "Czech Republic" },
  берлин: { code: "BER", name: "Berlin", country: "Germany" },
  амстердам: { code: "AMS", name: "Amsterdam", country: "Netherlands" },
  лиссабон: { code: "LIS", name: "Lisbon", country: "Portugal" },
};

export async function lookupIata(city: string) {
  const key = city.trim().toLowerCase();
  if (!key) return null;
  try {
    const results = (await fetchJson(
      `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(city)}&locale=ru&types[]=city`,
      {},
      6000,
    )) as {
      type?: string;
      code?: string;
      name?: string;
      country_name?: string;
      city_name?: string;
    }[];
    const hit = (results || []).find((r) => r.type === "city" && r.code);
    if (hit?.code) {
      const cityEn = hit.name || city;
      const countryEn = hit.country_name || "";
      return {
        code: hit.code,
        name: hit.city_name || cityEn,
        country: countryEn,
        city_slug: slug(cityEn),
        country_slug: slug(countryEn),
      };
    }
  } catch {
    /* fallback below */
  }
  const hint = IATA_HINTS[key];
  if (!hint) return null;
  return {
    ...hint,
    city_slug: slug(hint.name),
    country_slug: slug(hint.country),
  };
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export async function detectGeoIp(request: Request) {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = fwd || request.headers.get("x-real-ip") || "";
  try {
    const url = ip && !["127.0.0.1", "::1"].includes(ip) ? `https://ipwho.is/${ip}` : "https://ipwho.is/";
    const data = (await fetchJson(url, {}, 5000)) as {
      success?: boolean;
      city?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
    };
    if (data?.success !== false && data.city) {
      const iata = await lookupIata(data.city);
      return {
        success: true,
        iata: iata?.code || "",
        name: data.city,
        country: data.country || "",
        coordinates: data.latitude && data.longitude ? `${data.latitude},${data.longitude}` : "",
      };
    }
  } catch {
    /* default */
  }
  return {
    success: true,
    iata: "MOW",
    name: "Москва",
    country: "Россия",
    coordinates: "55.75,37.62",
  };
}

export async function currencyRates() {
  const rates: Record<string, number> = { RUB: 1 };
  try {
    const xml = await (await fetch("https://www.cbr.ru/scripts/XML_daily.asp", {
      headers: { "User-Agent": "TravelBase/1.0" },
    })).text();
    const re = /<CharCode>([A-Z]{3})<\/CharCode>[\s\S]*?<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([0-9,]+)<\/Value>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const code = m[1];
      const nominal = Number(m[2]);
      const value = Number(m[3].replace(",", "."));
      if (nominal > 0 && value > 0) rates[code] = value / nominal;
    }
  } catch {
    Object.assign(rates, { USD: 90, EUR: 98, GBP: 118, TRY: 2.6, THB: 2.6, JPY: 0.61, CNY: 12.5, AED: 24.5 });
  }
  return { success: true, date: new Date().toISOString().slice(0, 10), ratesToRub: rates };
}

export function hotelLinks(input: Record<string, unknown>) {
  const city = str(input.cityName || input.location, "city");
  const iata = str(input.iata);
  const checkIn = str(input.checkIn);
  const checkOut = str(input.checkOut);
  const q = encodeURIComponent(city);
  const dates = checkIn && checkOut ? `&checkin=${checkIn}&checkout=${checkOut}` : "";
  return {
    success: true,
    cityName: city,
    links: [
      {
        service: "Hotellook",
        description: "Сравнение отелей",
        url: `https://search.hotellook.com/hotels?destination=${encodeURIComponent(iata || city)}${checkIn ? `&checkIn=${checkIn}` : ""}${checkOut ? `&checkOut=${checkOut}` : ""}`,
      },
      {
        service: "Ostrovok",
        description: "Отели и апартаменты",
        url: `https://ostrovok.ru/hotel/search/?q=${q}${dates}`,
      },
      {
        service: "Aviasales",
        description: "Жильё рядом с перелётом",
        url: `https://www.aviasales.ru/hotels?destination=${q}`,
      },
    ],
  };
}
