import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

// Изолированная пустая база знаний: кандидаты — только 20 пресетов, эвристика.
process.env.KB_DB_PATH = mkdtempSync(path.join(tmpdir(), "tb-match-test-"));
delete process.env.MOONSHOT_API_KEY;
const HERE = path.dirname(fileURLToPath(import.meta.url));
register(
  pathToFileURL(path.join(HERE, "../../../scripts/lib/node-ts-loader.mjs")).href,
  import.meta.url,
);
const { matchDestinations, parseMatchAnswers } = await import("./match.ts");

const ANSWERS = {
  style: "active",
  visa: "russia-only",
  budget: "low",
  month: "июль",
  companions: "friends",
  climate: "any",
  flightHours: 0,
};

describe("matchDestinations (эвристика без ключа)", () => {
  it("visa=russia-only не предлагает заграницу", async () => {
    const r = await matchDestinations(ANSWERS);
    assert.equal(r.ok, true);
    assert.equal(r.source, "heuristic");
    assert.ok(r.results.length >= 4 && r.results.length <= 6);
    for (const item of r.results) {
      assert.equal(item.country, "Россия", `${item.city} — не Россия`);
    }
  });

  it("формат ответа стабилен: scores по 6 критериям, percent 0–100, reason и tripTypes", async () => {
    const r = await matchDestinations({ ...ANSWERS, visa: "any" });
    for (const item of r.results) {
      assert.ok(item.city && item.country && item.flag);
      for (const key of ["style", "budget", "season", "climate", "visa", "flight"] as const) {
        assert.ok(item.scores[key] >= 1 && item.scores[key] <= 10, `${item.city}.scores.${key}`);
      }
      assert.ok(item.matchPercent >= 0 && item.matchPercent <= 100);
      assert.equal(typeof item.reason, "string");
      assert.ok(Array.isArray(item.tripTypes));
    }
    // сортировка по убыванию совпадения
    const pcts = r.results.map((x) => x.matchPercent);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));
  });

  it("кэш: повторный вызов с той же анкетой отдаёт те же результаты из кэша", async () => {
    const answers = { ...ANSWERS, visa: "any", climate: "warm" };
    const first = await matchDestinations(answers);
    const second = await matchDestinations(answers);
    assert.equal(second.candidatesCount, 0, "второй вызов должен идти из кэша");
    assert.deepEqual(second.results, first.results);
    assert.equal(second.source, first.source);
  });
});

describe("parseMatchAnswers", () => {
  it("подставляет дефолты и клампит flightHours", () => {
    const a = parseMatchAnswers({ style: "hacker", visa: "no-visa", flightHours: 99, month: "  Июль " });
    assert.equal(a.style, "mixed");
    assert.equal(a.visa, "no-visa");
    assert.equal(a.budget, "mid");
    assert.equal(a.flightHours, 24);
    assert.equal(a.month, "Июль");
    const b = parseMatchAnswers({});
    assert.deepEqual(b, {
      style: "mixed", visa: "any", budget: "mid", month: "",
      companions: "couple", climate: "any", flightHours: 0,
    });
  });
});
