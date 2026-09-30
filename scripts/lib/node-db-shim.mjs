// @ts-check
/**
 * Замена src/lib/db.ts для офлайн Node-скриптов (краулер, экстрактор):
 * тот же интерфейс getSql(), но без Vite-магии (import.meta.glob). Миграции
 * читаются из migrations/ с диска. DATABASE_URL → pg, иначе PGLite-файл
 * data/kb.db (та же база, что у scripts/crawl-sources.mjs).
 */
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pendingMigrations } from "../migration-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let sqlPromise = null;
let closer = null;

/** Паритет с src/lib/db.ts: "neon" при DATABASE_URL, иначе "pglite". */
export const dbSource = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";

export async function getSql() {
  sqlPromise ??= open();
  return sqlPromise;
}

export async function closeDb() {
  if (closer) await closer().catch(() => {});
  sqlPromise = null;
  closer = null;
}

async function open() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    closer = () => pool.end();
    const run = async (text, params = []) => (await pool.query(text, params)).rows;
    return toSql(run);
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dbDir = path.join(ROOT, "data", "kb.db");
  await mkdir(path.dirname(dbDir), { recursive: true });
  const pg = new PGlite(dbDir);
  await pg.waitReady;
  closer = () => pg.close();
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const entries = await readdir(path.join(ROOT, "migrations"));
  const done = (await pg.query("select name from _migrations")).rows.map((r) => r.name);
  for (const { name } of pendingMigrations(entries, done)) {
    const text = await readFile(path.join(ROOT, "migrations", name), "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query("insert into _migrations (name) values ($1)", [name]);
    });
  }
  const run = async (text, params = []) => (await pg.query(text, params)).rows;
  return toSql(run);
}

function toSql(run) {
  const sql = (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run(text, values);
  };
  sql.query = (text, params = []) => run(text, params);
  return sql;
}
