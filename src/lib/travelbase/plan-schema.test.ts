import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipPlanDays, parsePlanJson } from "./plan-schema.ts";

const VALID_PLAN = {
  destination: "Казань",
  country: "Россия",
  theme: "Популярные места",
  days: [
    {
      day: 1,
      district: "Центр",
      places: [
        { name: "Казанский кремль", address: "Казань" },
        { name: "Кул-Шариф", address: "Казань" },
      ],
    },
    { day: 2, district: "Слобода", places: [{ name: "Чаша", address: "Казань" }] },
    { day: 3, district: "Набережная", places: [{ name: "Набережная", address: "Казань" }] },
  ],
};

/** Полный план (после parsePlanJson) — для тестов clipPlanDays. */
const FULL_PLAN = (() => {
  const parsed = parsePlanJson(VALID_PLAN);
  if (!parsed) throw new Error("fixture must parse");
  return parsed;
})();

describe("parsePlanJson", () => {
  it("принимает валидный план (объект и JSON-строку)", () => {
    const fromObject = parsePlanJson(VALID_PLAN);
    assert.ok(fromObject);
    assert.equal(fromObject.destination, "Казань");
    assert.equal(fromObject.days.length, 3);
    const fromString = parsePlanJson(JSON.stringify(VALID_PLAN));
    assert.deepEqual(fromString, fromObject);
  });

  it("отклоняет битый JSON", () => {
    assert.equal(parsePlanJson("{not json"), null);
    assert.equal(parsePlanJson("```"), null);
    assert.equal(parsePlanJson(42), null);
  });

  it("отклоняет план без days и с пустым days", () => {
    assert.equal(parsePlanJson({ destination: "Казань" }), null);
    assert.equal(parsePlanJson({ destination: "Казань", days: [] }), null);
  });

  it("отклоняет день без мест", () => {
    assert.equal(parsePlanJson({ destination: "Казань", days: [{ day: 1, places: [] }] }), null);
  });
});

describe("clipPlanDays", () => {
  it("режет план до нужного числа дней и перенумеровывает", () => {
    const clipped = clipPlanDays(FULL_PLAN, 2);
    assert.equal(clipped.days.length, 2);
    assert.deepEqual(clipped.days.map((d) => d.day), [1, 2]);
    assert.equal(clipped.days[0].district, "Центр");
  });

  it("не растягивает план шире исходного и не даёт меньше одного дня", () => {
    assert.equal(clipPlanDays(FULL_PLAN, 10).days.length, 3);
    assert.equal(clipPlanDays(FULL_PLAN, 0).days.length, 1);
  });
});
