// @ts-check
/**
 * autotravel.ru — авто-маршруты и отчёты по России (trust 6). Discover:
 * страница города /gorod/<slug>.html содержит ссылки на отчёты
 * /otklik.php/<id> (robots.txt их не закрывает; закрыты *small/*sml-варианты).
 * extract — readability-очистка. Только PRESET_RUSSIA.
 */
import { citySlugs, extractArticle, pageLinks } from "./lib.mjs";

const ALT_SLUGS = {
  алтай: ["gorno-altaysk", "altai"],
  камчатка: ["petropavlovsk-kamchatsky"],
  дагестан: ["derbent", "makhachkala"],
  байкал: ["listvyanka", "irkutsk"],
  карелия: ["petrozavodsk", "karelia"],
  "санкт-петербург": ["sankt-peterburg", "saint-petersburg", "spb"],
};

export default {
  id: "autotravel",
  scope: "russia",

  async discover(dest, ctx) {
    const slugs = [...citySlugs(dest.city), ...(ALT_SLUGS[dest.city.toLowerCase()] || [])];
    if (!slugs.length) return [];
    for (const slug of slugs) {
      const cityUrl = `https://autotravel.ru/gorod/${slug}.html`;
      const res = await ctx.fetchPage(cityUrl);
      if (res.status !== 200 || !res.text) continue;
      const reports = pageLinks(res.text, cityUrl, (u) =>
        /^https:\/\/autotravel\.ru\/otklik\.php\/\d+$/.test(u),
      );
      return [cityUrl, ...reports].slice(0, 30);
    }
    return [];
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
