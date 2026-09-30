// @ts-check
/**
 * kuda-go.com (kudago.com) — агрегатор событий и мест по городам РФ (trust 5).
 * HTML-сайт отдаёт 403 на ботовый UA, но официальное публичное API
 * kudago.com/public-api/v1.4 доступно — источник читается через него
 * (skipRobots, как у wikivoyage: это санкционированный машинный интерфейс).
 * Discover — /places/?city=<code>, fetchArticle — детали места. В url пишем
 * site_url площадки (атрибуция), fallback — URL объекта на kudago.com.
 * Только PRESET_RUSSIA и только города, покрытые API.
 */
import { htmlToText } from "./lib.mjs";

const API = "https://kudago.com/public-api/v1.4";
// Города PRESET_RUSSIA, для которых у KudaGo API есть код.
const CITY_CODES = {
  казань: "kzn",
  сочи: "sochi",
  калининград: "kaliningrad",
  "санкт-петербург": "spb",
};

export default {
  id: "kuda-go",
  scope: "russia",

  async discover(dest, ctx) {
    const code = CITY_CODES[dest.city.toLowerCase()];
    if (!code) return [];
    const url = `${API}/places/?location=${code}&page_size=30&fields=id,title`;
    const res = await ctx.fetchPage(url, { skipRobots: true, accept: "application/json" });
    if (res.status !== 200 || !res.text) throw new Error(`KudaGo API HTTP ${res.status}`);
    const data = JSON.parse(res.text);
    return (data.results || [])
      .filter((p) => p.id != null)
      .map((p) => `${API}/places/${p.id}/?fields=id,title,description,site_url,body_text`);
  },

  async fetchArticle(url, ctx) {
    const res = await ctx.fetchPage(url, { skipRobots: true, accept: "application/json" });
    if (res.status !== 200 || !res.text) return null;
    const data = JSON.parse(res.text);
    const text = htmlToText(data.body_text || data.description || "");
    if (text.length < 400) return null;
    return {
      title: data.title || "",
      text,
      canonicalUrl: data.site_url || url,
    };
  },
};
