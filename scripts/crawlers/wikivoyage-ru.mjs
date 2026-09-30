// @ts-check
/**
 * ru.wikivoyage.org — путеводитель (trust 9). Только официальный MediaWiki API
 * (action=query, list=search / prop=extracts&explaintext), HTML не парсим.
 * API — санкционированный машинный интерфейс, поэтому запросы к /w/api.php
 * идут с skipRobots (robots.txt Wikimedia закрывает /w/ от HTML-краулеров).
 * В raw_documents.url пишем канонический /wiki/<title> — для CC BY-SA
 * атрибуции в UI.
 */
const API = "https://ru.wikivoyage.org/w/api.php";

async function api(ctx, params) {
  const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await ctx.fetchPage(url, { skipRobots: true, accept: "application/json" });
  if (res.status !== 200 || !res.text) throw new Error(`wikivoyage API HTTP ${res.status}`);
  return JSON.parse(res.text);
}

export default {
  id: "wikivoyage-ru",
  scope: "both",

  async discover(dest, ctx) {
    const data = await api(ctx, {
      action: "query",
      list: "search",
      srsearch: dest.city,
      srnamespace: "0",
      srlimit: "30",
    });
    const hits = data?.query?.search || [];
    return hits
      .filter((h) => h.title && !h.title.includes("(")) // отсекаем disambiguation-страницы
      .map((h) => `https://ru.wikivoyage.org/wiki/${encodeURIComponent(h.title)}`);
  },

  async fetchArticle(url, ctx) {
    const title = decodeURIComponent(url.split("/wiki/")[1] || "").replace(/_/g, " ");
    if (!title) return null;
    const data = await api(ctx, {
      action: "query",
      prop: "extracts",
      explaintext: "1",
      redirects: "1",
      titles: title,
    });
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing != null || !page.extract) return null;
    const canonical = `https://ru.wikivoyage.org/wiki/${encodeURIComponent(page.title)}`;
    return { title: page.title, text: page.extract, canonicalUrl: canonical };
  },
};
