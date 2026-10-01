import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseExtraction } from "./kb-schema.ts";

const VALID = {
  places: [
    { name: "Казанский кремль", kind: "attraction", description: "Крепость ЮНЕСКО", price_hint: "бесплатно", season_hint: "круглый год" },
    { name: "Кул-Шариф" },
  ],
  facts: [{ category: "транспорт", text: "Из аэропорта ходит аэроэкспресс." }],
  routes: [{ title: "Казань за день", days: [["Казанский кремль", "Кул-Шариф"]] }],
};

describe("parseExtraction", () => {
  it("принимает валидную экстракцию и применяет дефолты", () => {
    const r = parseExtraction(VALID);
    assert.equal(r.places.length, 2);
    assert.equal(r.places[1].kind, "attraction"); // дефолт kind
    assert.equal(r.places[1].description, "");
    assert.equal(r.facts[0].category, "транспорт");
    assert.deepEqual(r.routes[0].days[0], ["Казанский кремль", "Кул-Шариф"]);
  });

  it("добавляет дефолтные пустые массивы при частичном ответе", () => {
    const r = parseExtraction({ places: [] });
    assert.deepEqual(r, { places: [], facts: [], routes: [] });
  });

  it("отклоняет мусор и возвращает пустую экстракцию", () => {
    assert.deepEqual(parseExtraction(null), { places: [], facts: [], routes: [] });
    assert.deepEqual(parseExtraction("not json"), { places: [], facts: [], routes: [] });
    assert.deepEqual(parseExtraction({ places: [{ name: "x" }] }), { places: [], facts: [], routes: [] });
  });

  it("отклоняет слишком длинные days в routes", () => {
    const bad = {
      routes: [{ title: "Марафон", days: Array.from({ length: 20 }, () => ["место"]) }],
    };
    assert.deepEqual(parseExtraction(bad), { places: [], facts: [], routes: [] });
  });
});
