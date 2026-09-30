// @ts-check
/**
 * openarium.ru — отчёты самостоятельных путешественников по России (trust 6).
 * Discover: страница региона/города /russia/<slug>/ → ссылки на статьи и POI
 * того же региона. extract — readability-очистка. Только PRESET_RUSSIA.
 */
import { citySlugs, extractArticle, pageLinks } from "./lib.mjs";

export default {
  id: "openarium",
  scope: "russia",

  async discover(dest, ctx) {
    const slugs = citySlugs(dest.city);
    if (!slugs.length) return [];
    for (const slug of slugs) {
      const hubUrl = `https://openarium.ru/russia/${slug}/`;
      const res = await ctx.fetchPage(hubUrl);
      if (res.status !== 200 || !res.text) continue;
      const links = pageLinks(res.text, hubUrl, (u) => {
        if (!u.startsWith("https://openarium.ru/")) return false;
        if (u.includes("/dostoprimechatelnosti/")) return true; // подборки мест
        if (/\/poi\/\d+\//.test(u)) return true; // страницы достопримечательностей
        return new RegExp(`^https://openarium\\.ru/russia/${slug}/[a-z0-9-]+/$`, "i").test(u);
      });
      if (links.length) return [hubUrl, ...links].slice(0, 30);
    }
    return [];
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
