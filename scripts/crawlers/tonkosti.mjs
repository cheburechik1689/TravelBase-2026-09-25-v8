// @ts-check
/**
 * tonkosti.ru — путеводитель по курортам и странам (trust 7). Движок
 * MediaWiki, URL страниц — кириллические (tonkosti.ru/Париж). Discover через
 * sitemap-index (gzip, кириллица в percent-encoding — lib сматчит decoded),
 * extract — readability-очистка. robots.txt закрывает /api.php, поэтому
 * только HTML-страницы, без API.
 */
import { extractArticle, sitemapUrls } from "./lib.mjs";

export default {
  id: "tonkosti",
  scope: "both",

  async discover(dest, ctx) {
    // Индекс отдаёт детей вида sitemap-wikidb-NS_0-N.xml.gz — там основные
    // статьи. Совпадение по имени города как целого slug (tonkosti.ru/Париж).
    const needle = `/${encodeURIComponent(dest.city)}`.toLowerCase();
    const urls = await sitemapUrls("https://tonkosti.ru/sitemap.xml", ctx.fetchBuffer, {
      needle,
      maxSitemaps: 15,
    });
    return urls.slice(0, 30);
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
