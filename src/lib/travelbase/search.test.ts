import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

// Изолированная БД + лоадер для @/-алиаса (search.ts тянет geo-cache → @/lib/db).
process.env.KB_DB_PATH = mkdtempSync(path.join(tmpdir(), "tb-search-test-"));
const HERE = path.dirname(fileURLToPath(import.meta.url));
register(
  pathToFileURL(path.join(HERE, "../../../scripts/lib/node-ts-loader.mjs")).href,
  import.meta.url,
);
const { assembleFromCatalog } = await import("./search.ts");

// 10 POI плотным кластером (~2 км) вокруг условного центра.
const poi = (name: string, kind: string, dLat: number, dLon: number, food = false) => ({
  name,
  lat: 55.75 + dLat,
  lon: 37.61 + dLon,
  kind,
  food,
});
const CATALOG = [
  poi("Кремль", "castle", 0.005, 0.005),
  poi("Исторический музей", "museum", 0.006, 0.008),
  poi("Собор Василия Блаженного", "church", 0.004, 0.01),
  poi("ГУМ", "attraction", 0.007, 0.007),
  poi("Парк Зарядье", "park", 0.003, 0.014),
  poi("Оружейная палата", "museum", 0.004, 0.003),
  poi("Храм Христа Спасителя", "church", 0.001, -0.01),
  poi("Столовая 57", "restaurant", 0.006, 0.008, true),
  poi("Кафе Пушкин", "cafe", 0.002, 0.004, true),
  poi("Му-Му", "cafe", 0.005, 0.012, true),
];

describe("assembleFromCatalog", () => {
  it("собирает корректное число дней с 5–6 точками в первом дне", async () => {
    const plan = await assembleFromCatalog({
      destination: "Москва",
      days: 2,
      theme: "Популярные места",
      currency: "RUB",
      wishes: "",
      catalog: CATALOG,
    });
    assert.ok(plan);
    assert.equal(plan.days.length, 2);
    assert.ok(
      plan.days[0].places.length >= 5 && plan.days[0].places.length <= 6,
      `день 1: ${plan.days[0].places.length} мест`,
    );
    assert.ok(plan.days[1].places.length >= 3, `день 2: ${plan.days[1].places.length} мест`);
  });

  it("включает еду и не дублирует места", async () => {
    const plan = await assembleFromCatalog({
      destination: "Москва",
      days: 2,
      theme: "Популярные места",
      currency: "RUB",
      wishes: "",
      catalog: CATALOG,
    });
    assert.ok(plan);
    const names = plan.days.flatMap((d) => d.places.map((p) => p.name));
    assert.ok(names.some((n) => /Столовая 57|Кафе Пушкин|Му-Му/.test(n)), "еда не попала в план");
    assert.equal(new Set(names).size, names.length, "дубли мест в плане");
  });

  it("порядок точек внутри дня связный: первый шаг без перехода, все координаты валидны", async () => {
    const plan = await assembleFromCatalog({
      destination: "Москва",
      days: 2,
      theme: "Популярные места",
      currency: "RUB",
      wishes: "",
      catalog: CATALOG,
    });
    assert.ok(plan);
    for (const day of plan.days) {
      day.places.forEach((p, i) => {
        assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.name}: нет координат`);
        if (i === 0) assert.equal(p.walkMinFromPrev, 0);
        else assert.ok(p.walkMinFromPrev >= 3 && p.walkMinFromPrev <= 90);
      });
    }
  });

  it("возвращает null при каталоге меньше трёх достопримечательностей", async () => {
    const plan = await assembleFromCatalog({
      destination: "Москва",
      days: 2,
      theme: "Популярные места",
      currency: "RUB",
      wishes: "",
      catalog: CATALOG.slice(0, 2),
    });
    assert.equal(plan, null);
  });
});
