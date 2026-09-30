// @ts-check
/**
 * Shared helpers for source adapters (scripts/crawlers/<source>.mjs):
 * sitemap traversal and readability-lite HTML→text extraction.
 * Everything network-bound goes through ctx.fetchPage from the engine,
 * so rate limits / robots.txt / ETag stay in one place.
 */
import { gunzipSync } from "node:zlib";

/**
 * @param {string} html
 * @param {string} _url
 * @returns {{ title: string, text: string } | null}
 */
export function extractArticle(html, _url) {
  if (!html || typeof html !== "string") return null;
  let doc = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const title =
    pick(doc, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    pick(doc, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    "";

  // Prefer the article body over the whole page: drop chrome blocks first.
  doc = doc
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");

  const body =
    pick(doc, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
    pick(doc, /<div[^>]*itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div|section|footer|aside)/i) ||
    pick(doc, /<main[^>]*>([\s\S]*?)<\/main>/i) ||
    pick(doc, /<body[^>]*>([\s\S]*?)<\/body>/i) ||
    doc;

  const text = htmlToText(body);
  if (text.length < 400) return null;
  return { title: decodeEntities(title).trim().slice(0, 300), text };
}

const locsCache = new Map();

async function sitemapLocs(sitemapUrl, fetchBuffer, maxSitemaps) {
  if (locsCache.has(sitemapUrl)) return locsCache.get(sitemapUrl);
  const seen = new Set();
  const locs = [];
  const queue = [sitemapUrl];
  let sitemaps = 0;
  while (queue.length && sitemaps < maxSitemaps && locs.length < 500000) {
    const sm = queue.shift();
    if (!sm || seen.has(sm)) continue;
    seen.add(sm);
    sitemaps += 1;
    let xml;
    try {
      const res = await fetchBuffer(sm);
      if (res.status !== 200 || !res.buffer) continue;
      xml = sm.endsWith(".gz") ? gunzipSync(res.buffer).toString("utf8") : res.buffer.toString("utf8");
    } catch {
      continue;
    }
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const loc = m[1].trim();
      if (/\.xml(\.gz)?$/i.test(loc) && loc.includes("sitemap")) {
        if (!seen.has(loc)) queue.push(loc);
      } else {
        locs.push(loc);
      }
    }
  }
  locsCache.set(sitemapUrl, locs);
  return locs;
}

/**
 * Collect URLs from a sitemap (index or urlset), following .gz and nested
 * indexes. Returns URLs matching `needle` (raw или percent-decoded form).
 * Parsed loc-листы кэшируются на процесс: десятки направлений не качают
 * одни и те же sitemap-файлы заново.
 * @param {string} sitemapUrl
 * @param {(url: string) => Promise<{ status: number, buffer?: Buffer }>} fetchBuffer
 * @param {{ needle?: string, maxSitemaps?: number, maxUrls?: number }} [opts]
 */
export async function sitemapUrls(sitemapUrl, fetchBuffer, opts = {}) {
  const { needle = "", maxSitemaps = 25, maxUrls = 200000 } = opts;
  const locs = await sitemapLocs(sitemapUrl, fetchBuffer, maxSitemaps);
  if (!needle) return locs.slice(0, maxUrls);
  const out = [];
  for (const loc of locs) {
    let decoded = loc;
    try {
      decoded = decodeURIComponent(loc);
    } catch {
      /* keep raw */
    }
    if ([loc, decoded].some((v) => v.toLowerCase().includes(needle))) {
      out.push(loc);
      if (out.length >= maxUrls) break;
    }
  }
  return out;
}

/** @param {string} html @param {RegExp} re */
function pick(html, re) {
  const m = html.match(re);
  return m ? m[1] : "";
}

/** @param {string} html */
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|blockquote)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @param {string} s */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Absolute http(s) links from a page, filtered by a predicate. */
export function pageLinks(html, baseUrl, filter) {
  const out = new Set();
  for (const m of html.matchAll(/href="([^"#]+)"/gi)) {
    let abs;
    try {
      abs = new URL(m[1].replace(/&amp;/g, "&"), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    if (filter && !filter(abs)) continue;
    out.add(abs);
  }
  return [...out];
}

/**
 * Город из PRESET_* → латинский слаг, под которым его ищут сайты-источники.
 * Значение — массив вариантов (первый — основной).
 */
export const CITY_SLUGS = {
  париж: ["paris"],
  рим: ["rome", "rim"],
  стамбул: ["istanbul"],
  барселона: ["barcelona"],
  дубай: ["dubai"],
  лондон: ["london"],
  токио: ["tokyo"],
  бангкок: ["bangkok"],
  "нью-йорк": ["new-york", "newyork"],
  бали: ["bali"],
  алтай: ["altai", "altaj"],
  камчатка: ["kamchatka"],
  дагестан: ["dagestan"],
  суздаль: ["suzdal"],
  казань: ["kazan"],
  сочи: ["sochi"],
  байкал: ["baikal", "bajkal"],
  карелия: ["karelia"],
  калининград: ["kaliningrad"],
  "санкт-петербург": ["saint-petersburg", "petersburg", "spb"],
};

/** @param {string} city @returns {string[]} */
export function citySlugs(city) {
  return CITY_SLUGS[city.toLowerCase()] || [];
}
