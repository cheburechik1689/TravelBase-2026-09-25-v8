// @ts-check
/**
 * 34travel.me — городские гайды (trust 7). Discover через sitemap.xml
 * (плоский urlset, слаг города в URL поста), extract — readability-очистка.
 * Скоуп: города Европы/СНГ (PRESET_POPULAR).
 */
import { citySlugs, extractArticle, sitemapUrls } from "./lib.mjs";

export default {
  id: "34travel",
  scope: "popular",

  async discover(dest, ctx) {
    const slugs = citySlugs(dest.city);
    if (!slugs.length) return [];
    const urls = [];
    for (const slug of slugs) {
      const hits = await sitemapUrls("https://34travel.me/sitemap.xml", ctx.fetchBuffer, {
        needle: `/post/`,
      });
      // Фильтруем уже в памяти: слаг города как отдельный токен в слаге поста.
      const re = new RegExp(`/post/[a-z0-9-]*${slug}[a-z0-9-]*$`, "i");
      urls.push(...hits.filter((u) => re.test(u)));
      if (urls.length) break;
    }
    return urls.slice(0, 30);
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
