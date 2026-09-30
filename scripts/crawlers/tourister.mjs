// @ts-check
/**
 * tourister.ru — отчёты и дневники (trust 7). Discover через
 * sitemap_city.xml.gz: страницы городов /world/.../city/<slug> собирают
 * описание и отчёты по направлению (поиск на сайте закрыт robots.txt).
 * Точное совпадение слага в конце пути, чтобы "paris" не цеплял
 * "villeparisis". extract — readability-очистка.
 */
import { citySlugs, extractArticle, sitemapUrls } from "./lib.mjs";

export default {
  id: "tourister",
  scope: "both",

  async discover(dest, ctx) {
    for (const slug of citySlugs(dest.city)) {
      const hits = await sitemapUrls(
        "https://www.tourister.ru/sitemap_city.xml.gz",
        ctx.fetchBuffer,
        { needle: `/city/${slug}` },
      );
      const exact = hits.filter((u) => new RegExp(`/city/${slug}[/?]?$`, "i").test(u));
      if (exact.length) return exact.slice(0, 5);
    }
    return [];
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
