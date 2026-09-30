// @ts-check
/**
 * vokrugsveta.ru — журнал, длинные тексты о местах (trust 6). Поиска и
 * sitemap с серверной выдачей нет (SPA), поэтому источник — broadcast:
 * discover идёт через RSS-ленту (разрешена robots.txt), направление каждой
 * статьи движок определяет по заголовку/описанию. extract —
 * readability-очистка страницы статьи.
 */
import { extractArticle } from "./lib.mjs";

const FEEDS = ["https://www.vokrugsveta.ru/rss-feeds/rss.xml"];

function stripCdata(s) {
  return (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

export default {
  id: "vokrugsveta",
  scope: "both",
  broadcast: true,

  async discover(_dest, ctx) {
    const out = [];
    for (const feedUrl of FEEDS) {
      const res = await ctx.fetchPage(feedUrl, { accept: "application/rss+xml,*/*" });
      if (res.status !== 200 || !res.text) {
        throw new Error(`RSS HTTP ${res.status}`);
      }
      for (const m of res.text.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const body = m[1];
        const title = stripCdata((body.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
        const description = stripCdata(
          (body.match(/<description>([\s\S]*?)<\/description>/i) || [])[1],
        );
        const link = stripCdata((body.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
        if (link) out.push({ url: link, title, description });
      }
    }
    return out;
  },

  async extract(html, url) {
    return extractArticle(html, url);
  },
};
