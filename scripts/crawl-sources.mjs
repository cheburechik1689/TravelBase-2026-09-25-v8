#!/usr/bin/env node
// @ts-check
/**
 * Knowledge-base crawler: русскоязычные источники → raw_documents.
 *
 *   node scripts/crawl-sources.mjs --all
 *   node scripts/crawl-sources.mjs tourister [--dest "Париж"] [--limit 30]
 *
 * Architecture: this engine owns the queue, robots.txt, per-domain politeness
 * (1 req / 2 s), ETag/Last-Modified revalidation, dedup and DB writes.
 * Each source lives in scripts/crawlers/<id>.mjs and provides:
 *
 *   export default {
 *     id,                        // must match sources.id and the file name
 *     scope: "popular" | "russia" | "both",   // which preset lists to walk
 *     discover?(destination, ctx) => [{ url, title? }],   // article URLs
 *     extract?(html, url) => { title, text } | null,      // readability cleanup
 *     fetchArticle?(url, ctx) => { title, text, canonicalUrl } | null, // API sources
 *   }
 *
 * ctx = { fetchPage, fetchBuffer, log }. All network goes through ctx so the
 * politeness/robots rules cannot be bypassed by an adapter. API sources
 * (wikivoyage) use opts.skipRobots on the official API endpoint only.
 *
 * DB: DATABASE_URL → pg; otherwise a file-backed PGLite at ./data/kb.db with
 * migrations/ applied first. One bad URL or a whole site failing never stops
 * the run — it is logged as "skipped: <reason>" and counted.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pendingMigrations } from "./migration-plan.mjs";
import { destinationKey } from "../src/lib/travelbase/security.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "TravelBaseBot/1.0 (+https://grok.com; travelbase-kb-crawler)";
const POLITENESS_MS = 2000;
const DEFAULT_LIMIT = 30; // documents per source × destination
const MIN_TEXT_LEN = 800;
const MAX_TEXT_LEN = 60000;
const SOURCE_TIMEOUT_MS = 10 * 60 * 1000; // жёсткий бюджет на один источник

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Destinations: PRESET_POPULAR + PRESET_RUSSIA from src/lib/travelbase/catalog.ts
// (parsed as text — plain Node can't resolve the file's extensionless imports).
// ---------------------------------------------------------------------------
async function loadPresets() {
  const src = await readFile(join(ROOT, "src/lib/travelbase/catalog.ts"), "utf8");
  const read = (name) => {
    const m = src.match(new RegExp(`export const ${name} = (\\[[\\s\\S]*?\\]);`));
    if (!m) throw new Error(`catalog.ts: ${name} not found`);
    return new Function(`return ${m[1]}`)();
  };
  return { popular: read("PRESET_POPULAR"), russia: read("PRESET_RUSSIA") };
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
async function openDb() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    return {
      kind: "pg",
      query: async (text, params = []) => (await pool.query(text, params)).rows,
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dbDir = join(ROOT, "data", "kb.db");
  await mkdir(dirname(dbDir), { recursive: true });
  const pg = new PGlite(dbDir);
  await pg.waitReady;
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const entries = await readdir(join(ROOT, "migrations"));
  const done = (await pg.query("select name from _migrations")).rows.map((r) => r.name);
  for (const { name } of pendingMigrations(entries, done)) {
    const text = await readFile(join(ROOT, "migrations", name), "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query("insert into _migrations (name) values ($1)", [name]);
    });
    console.log(`[crawl] migration applied: ${name}`);
  }
  return {
    kind: "pglite",
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    close: () => pg.close(),
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = m;
    if (field.toLowerCase() === "user-agent") {
      const ua = value.toLowerCase();
      current = groups.find((g) => g.ua === ua);
      if (!current) {
        current = { ua, rules: [] };
        groups.push(current);
      }
    } else if (current) {
      current.rules.push({ allow: field.toLowerCase() === "allow", path: value });
    }
  }
  return groups;
}

function robotsAllows(robots, url, { wholeSite = false } = {}) {
  if (!robots) return true;
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  const group =
    robots.find((g) => g.ua === "travelbasebot") || robots.find((g) => g.ua === "*");
  if (!group) return true; // no group for us → allowed
  if (wholeSite) {
    // "Disallow: /" with no Allow exceptions means the site is off-limits.
    const bansAll = group.rules.some((r) => !r.allow && r.path === "/");
    return !bansAll;
  }
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue;
    if (!path.toLowerCase().startsWith(r.path.toLowerCase())) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// Fetch with politeness + ETag state + source deadline
// ---------------------------------------------------------------------------
const URL_TIMEOUT_MS = 30_000;
const MAX_FETCH_RETRIES = 2; // до 2 ретраев после первой неудачной попытки

function makeFetch({ robotsByHost, state, log, deadline }) {
  const lastHit = new Map();

  async function paced(url) {
    const host = new URL(url).hostname;
    const wait = POLITENESS_MS - (Date.now() - (lastHit.get(host) || 0));
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    if (deadline && Date.now() > deadline) throw new Error("source timeout");
  }

  async function oneAttempt(url, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
      const buffer = Buffer.from(await res.arrayBuffer());
      return { res, buffer };
    } finally {
      clearTimeout(timer);
    }
  }

  async function raw(url, opts = {}) {
    const host = new URL(url).hostname;
    const robots = robotsByHost.get(host);
    if (!opts.skipRobots && robots && !robotsAllows(robots, url)) {
      return { status: 0, disallowed: true, buffer: null, text: "", headers: new Headers() };
    }
    await paced(url);
    const headers = { "User-Agent": UA, Accept: opts.accept || "text/html,*/*" };
    const st = state[url];
    if (st?.etag) headers["If-None-Match"] = st.etag;
    if (st?.lastModified) headers["If-Modified-Since"] = st.lastModified;

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
      if (attempt > 0) await paced(url);
      try {
        const { res, buffer } = await oneAttempt(url, headers);
        if (res.status === 304 && opts.allowNotModified) {
          return { status: 304, notModified: true, buffer: null, text: "", headers: res.headers };
        }
        if (res.status === 304) {
          // Тело на 304 не приходит, а закэшированной копии у нас нет (в state
          // только валидаторы) — для sitemap/API/лент повторяем без If-*.
          delete headers["If-None-Match"];
          delete headers["If-Modified-Since"];
          await paced(url);
          const retry = await oneAttempt(url, headers);
          return { status: retry.res.status, buffer: retry.buffer, headers: retry.res.headers };
        }
        const etag = res.headers.get("etag");
        const lastMod = res.headers.get("last-modified");
        if (res.ok && (etag || lastMod)) {
          state[url] = { etag: etag || st?.etag, lastModified: lastMod || st?.lastModified };
        }
        return { status: res.status, buffer, headers: res.headers };
      } catch (err) {
        lastErr = err;
        // Сетевой сбой — ретрай; истёкший дедлайн источника — сразу наружу.
        if (deadline && Date.now() > deadline) throw new Error("source timeout", { cause: err });
      }
    }
    throw lastErr || new Error("fetch failed");
  }

  function decode(res) {
    const ct = res.headers.get("content-type") || "";
    let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
    if (!charset) {
      const head = res.buffer.subarray(0, 4096).toString("latin1");
      charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1];
    }
    try {
      return new TextDecoder((charset || "utf-8").toLowerCase()).decode(res.buffer);
    } catch {
      return res.buffer.toString("utf8");
    }
  }

  return {
    async fetchPage(url, opts = {}) {
      const res = await raw(url, opts);
      if (res.buffer) res.text = decode(res);
      return res;
    },
    async fetchBuffer(url, opts = {}) {
      return raw(url, { ...opts, accept: "*/*" });
    },
    log,
  };
}

// ---------------------------------------------------------------------------
// Dedup + upsert
// ---------------------------------------------------------------------------
async function storeDocument(db, doc) {
  const existing = await db.query("select id, hash from raw_documents where url = $1", [doc.url]);
  if (existing[0]) {
    if (existing[0].hash === doc.hash) return "unchanged";
    await db.query(
      "update raw_documents set title = $2, content = $3, hash = $4, destination_key = $5, fetched_at = now() where url = $1",
      [doc.url, doc.title, doc.content, doc.hash, doc.destinationKey],
    );
    return "updated";
  }
  const sameHash = await db.query(
    "select id from raw_documents where source_id = $1 and hash = $2 limit 1",
    [doc.sourceId, doc.hash],
  );
  if (sameHash[0]) return "duplicate";
  await db.query(
    `insert into raw_documents (id, source_id, url, title, lang, destination_key, content, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [doc.id, doc.sourceId, doc.url, doc.title, doc.lang, doc.destinationKey, doc.content, doc.hash],
  );
  return "inserted";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  if (!target) {
    console.error("usage: node scripts/crawl-sources.mjs <source_id|--all> [--dest <city>] [--limit N]");
    process.exit(2);
  }
  const destFilter = args.includes("--dest") ? args[args.indexOf("--dest") + 1] : null;
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : DEFAULT_LIMIT;

  const db = await openDb();
  console.log(`[crawl] db: ${db.kind}`);

  // ETag / Last-Modified state for revalidation across runs.
  const statePath = join(ROOT, "data", "crawl-state.json");
  let state = {};
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    /* first run */
  }

  const presets = await loadPresets();
  const sourceRows = await db.query(
    "select id, url, kind, trust from sources where active order by trust desc, id",
  );
  const wanted = target === "--all" ? sourceRows : sourceRows.filter((s) => s.id === target);
  if (!wanted.length) {
    console.error(`[crawl] unknown source: ${target}`);
    process.exit(2);
  }

  const robotsByHost = new Map();
  const robotsSkipped = [];
  const stats = [];
  let grandTotal = 0;

  for (const source of wanted) {
    const stat = { source: source.id, inserted: 0, updated: 0, unchanged: 0, duplicate: 0, skipped: 0, perDest: {} };
    stats.push(stat);
    let adapter;
    try {
      adapter = (await import(pathToFileURL(join(ROOT, "scripts/crawlers", `${source.id}.mjs`)).href)).default;
    } catch (err) {
      console.log(`[crawl] ${source.id}: skipped: no adapter (${err.message})`);
      stat.skipped += 1;
      continue;
    }
    const host = new URL(source.url).hostname;

    // robots.txt — fetched once per host. Unreachable robots means "allow all"
    // (standard crawler etiquette); an explicit "Disallow: /" skips the source.
    if (!robotsByHost.has(host)) {
      try {
        const res = await fetch(`https://${host}/robots.txt`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(10000),
        });
        robotsByHost.set(host, res.ok ? parseRobots(await res.text()) : null);
      } catch {
        robotsByHost.set(host, null);
      }
    }
    const robots = robotsByHost.get(host);
    if (robots && !robotsAllows(robots, source.url, { wholeSite: true })) {
      console.log(`[crawl] ${source.id}: skipped: robots.txt disallows crawling`);
      robotsSkipped.push(source.id);
      continue;
    }

    const log = (msg) => console.log(`[crawl] ${source.id}: ${msg}`);
    // Жёсткий бюджет на один источник: истёк → «skipped: timeout», следующий.
    const deadline = Date.now() + SOURCE_TIMEOUT_MS;
    const ctx = makeFetch({ robotsByHost, state, log, deadline });
    let sourceTimedOut = false;

    const dests = [
      ...(adapter.scope === "russia" ? [] : presets.popular),
      ...(adapter.scope === "popular" ? [] : presets.russia),
    ].filter((d) => !destFilter || d.city === destFilter);

    // Broadcast-адаптеры (RSS-ленты, журнальные потоки) не имеют поиска по
    // направлению: discover(null) вызывается один раз, а направление каждого
    // документа определяет destinationGuess, сматченный на PRESET-списки.
    let destGroups;
    if (adapter.broadcast) {
      let items;
      try {
        items = (await adapter.discover(null, ctx)) || [];
      } catch (err) {
        log(`discover skipped: ${err.message}`);
        stat.skipped += 1;
        continue;
      }
      const byCity = new Map();
      for (const item of items) {
        const guess = String(item.destinationGuess || "").toLowerCase();
        let city = dests.find((d) => d.city.toLowerCase() === guess)?.city;
        if (!city) {
          const hay = `${item.title || ""} ${item.description || ""}`.toLowerCase();
          city = dests.find((d) => hay.includes(d.city.toLowerCase()))?.city;
        }
        if (!city) continue;
        const list = byCity.get(city) || [];
        list.push(item);
        byCity.set(city, list);
      }
      destGroups = [...byCity.entries()].map(([city, urls]) => ({ city, urls }));
    } else {
      destGroups = dests.map((d) => ({ city: d.city, urls: null }));
    }

    for (const group of destGroups) {
      const dkey = destinationKey(group.city);
      let urls = group.urls;
      if (urls === null) {
        try {
          urls = (await adapter.discover({ city: group.city }, ctx)) || [];
        } catch (err) {
          log(`${group.city}: discover skipped: ${err.message}`);
          stat.skipped += 1;
          continue;
        }
      }
      let taken = 0;
      let processed = 0;
      for (const item of urls) {
        if (taken >= limit) break;
        const url = typeof item === "string" ? item : item.url;
        try {
          let article;
          let canonicalUrl = url;
          if (adapter.fetchArticle) {
            article = await adapter.fetchArticle(url, ctx);
            if (article?.canonicalUrl) canonicalUrl = article.canonicalUrl;
          } else {
            const res = await ctx.fetchPage(url, { allowNotModified: true });
            if (res.disallowed) {
              log(`${url} — skipped: robots.txt disallow`);
              stat.skipped += 1;
              continue;
            }
            if (res.notModified) {
              // Документ актуален — перепроверяем только хеш в БД, скачивать не надо.
              stat.unchanged += 1;
              taken += 1;
              continue;
            }
            if (res.status !== 200 || !res.text) {
              log(`${url} — skipped: HTTP ${res.status}`);
              stat.skipped += 1;
              continue;
            }
            article = adapter.extract ? await adapter.extract(res.text, url, ctx) : null;
          }
          if (!article || !article.text || article.text.length < MIN_TEXT_LEN) {
            stat.skipped += 1;
            continue;
          }
          const content = article.text.slice(0, MAX_TEXT_LEN);
          const hash = createHash("sha256").update(`${article.title}\n${content}`).digest("hex");
          const outcome = await storeDocument(db, {
            id: randomUUID(),
            sourceId: source.id,
            url: canonicalUrl,
            title: (article.title || "").slice(0, 300),
            lang: "ru",
            destinationKey: dkey,
            content,
            hash,
          });
          stat[outcome] += 1;
          if (outcome === "inserted" || outcome === "updated") {
            taken += 1;
            grandTotal += outcome === "inserted" ? 1 : 0;
          } else if (outcome === "unchanged") {
            taken += 1;
          }
          processed += 1;
          if (processed % 10 === 0) {
            log(`progress ${group.city}: ${taken}/${limit} docs, ${url}`);
          }
        } catch (err) {
          if (err.message === "source timeout") {
            log(`skipped: timeout (10 min budget)`);
            sourceTimedOut = true;
            break;
          }
          log(`${url} — skipped: ${err.message}`);
          stat.skipped += 1;
        }
      }
      stat.perDest[group.city] = (stat.perDest[group.city] || 0) + taken;
      log(`${group.city}: ${taken} doc(s)`);
      if (sourceTimedOut) break;
    }

    await db.query("update sources set last_crawled_at = now() where id = $1", [source.id]);
  }

  try {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state));
  } catch {
    /* state is an optimisation, never fail the run on it */
  }

  console.log("\n[crawl] ===== statistics =====");
  for (const s of stats) {
    console.log(
      `[crawl] ${s.source}: +${s.inserted} new, ${s.updated} updated, ${s.unchanged} unchanged, ${s.duplicate} dup, ${s.skipped} skipped`,
    );
    for (const [city, n] of Object.entries(s.perDest)) {
      if (n > 0) console.log(`[crawl]   ${city}: ${n}`);
    }
  }
  const totalRows = await db.query("select count(*)::int as n from raw_documents");
  console.log(`[crawl] robots.txt skipped sources: ${robotsSkipped.join(", ") || "none"}`);
  console.log(`[crawl] inserted this run: ${grandTotal}; raw_documents total: ${totalRows[0].n}`);

  await db.close();
}

main().catch((err) => {
  console.error("[crawl] fatal:", err);
  process.exit(1);
});
