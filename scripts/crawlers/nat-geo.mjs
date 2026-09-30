// @ts-check
/**
 * nat-geo.ru — природные направления (trust 6). Discover через sitemap.xml,
 * фильтр по кириллическому названию направления и латинскому слагу;
 * extract — readability-очистка. Если сайт недоступен из текущей сети,
 * движок запишет «skipped: <причина>» и пойдёт дальше.
 */
import { citySlugs, extractArticle, sitemapUrls } from "./lib.mjs";

export default {
  id: "nat-geo",
  scope: "both",

  async discover(dest, ctx) {
    // Из части сетей сайт недоступен вовсе — фиксируем причину явно.
    const probe = await ctx.fetchPage("https://nat-geo.ru/");
    if (probe.status !== 200) throw new Error(`HTTP ${probe.status} (unreachable/blocked)`);
    const needles = [dest.city.toLowerCase(), ...citySlugs(dest.city)];
    for (const needle of needles) {
      const hits = await sitemapUrls("https://nat-geo.ru/sitemap.xml", ctx.fetchBuffer, {
        needle,
        maxSitemaps: 20,
      });
      const articles = hits.filter((u) => !/sitemap|category|tag|author/.test(u));
      if (articles.length) return articles.slice(0, 30);
    }
    return [];
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
