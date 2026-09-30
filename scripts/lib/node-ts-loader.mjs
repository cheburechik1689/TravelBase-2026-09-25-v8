// @ts-check
/**
 * Node ESM resolve-hook для офлайн-скриптов (scripts/extract-knowledge.mjs),
 * которым нужен код из src/:
 *   - "@/..."            → <root>/src/...  (алиас из tsconfig)
 *   - "@/lib/db"         → scripts/lib/node-db-shim.mjs (PGLite/pg без Vite)
 *   - extensionless относительные импорты ("./http") → .ts/.mjs/.js
 *
 * Подключается через module.register() ДО динамического import() модулей src/.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_SHIM = path.join(ROOT, "scripts/lib/node-db-shim.mjs");

export async function resolve(specifier, context, next) {
  let s = specifier;
  if (s === "@/lib/db") {
    return next(pathToFileURL(DB_SHIM).href, context);
  }
  if (s.startsWith("@/")) {
    s = path.join(ROOT, "src", s.slice(2));
  }
  if (s.startsWith(".") || path.isAbsolute(s)) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : pathToFileURL(ROOT).pathname;
    const base = path.isAbsolute(s) ? s : path.resolve(path.dirname(parent), s);
    if (!path.extname(s) && !existsSync(base)) {
      for (const ext of [".ts", ".mjs", ".js"]) {
        if (existsSync(base + ext)) {
          s = base + ext;
          break;
        }
      }
    } else {
      s = base;
    }
  }
  return next(path.isAbsolute(s) ? pathToFileURL(s).href : s, context);
}
