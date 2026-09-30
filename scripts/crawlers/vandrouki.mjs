// @ts-check
/**
 * vandrouki.ru — лайфхаки, дешёвые билеты, маршруты выходного дня (trust 6).
 * Discover через sitemap (WordPress), extract — readability-очистка.
 * Сайт может отдавать 403 на ботовый User-Agent — тогда discover бросает
 * ошибку и движок пишет «skipped: HTTP 403».
 */
import { citySlugs, extractArticle, sitemapUrls } from "./lib.mjs";

export default {
  id: "vandrouki",
  scope: "both",

  async discover(dest, ctx) {
    // Сайт отдаёт 403 на ботовый User-Agent — фиксируем причину явно.
    const probe = await ctx.fetchPage("https://vandrouki.ru/");
    if (probe.status !== 200) throw new Error(`HTTP ${probe.status} (bot blocked)`);
    const slugs = citySlugs(dest.city);
    const needles = [dest.city.toLowerCase(), ...slugs];
    for (const needle of needles) {
      const hits = await sitemapUrls("https://vandrouki.ru/sitemap.xml", ctx.fetchBuffer, {
        needle,
        maxSitemaps: 20,
      });
      const posts = hits.filter((u) => !/sitemap|category|tag|page\//.test(u));
      if (posts.length) return posts.slice(0, 30);
    }
    return [];
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
