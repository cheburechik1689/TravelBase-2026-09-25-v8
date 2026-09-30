import type { PlanJson } from "./plan-schema";

export function planToText(plan: PlanJson, currency = "RUB"): string {
  const dayBlocks = plan.days.map((day) => {
    const places = day.places
      .map((p, i) => {
        const walk =
          i === 0
            ? ""
            : `\nОт предыдущего места: ${p.walkMinFromPrev} мин пешком`;
        return `${i + 1}. ${p.name.toUpperCase()}${p.address ? ` (${p.address})` : ""}
Время: ${p.timeStart}-${p.timeEnd}${walk}
На посещение: ${p.durationMin} мин
Описание: ${p.description || "Рекомендуем включить в пеший маршрут этого района."}
Цена: ${p.price || "бесплатно"}`;
      })
      .join("\n\n");
    return `День ${day.day} — РАЙОН: ${day.district || "Центр"}

${places}`;
  });

  const hotels =
    plan.hotels && plan.hotels.length
      ? plan.hotels
          .map(
            (h) =>
              `- ${h.name}${h.area ? ` — ${h.area}` : ""}${h.pricePerNight ? ` — ${h.pricePerNight}` : ""}${h.note ? `. ${h.note}` : ""}`,
          )
          .join("\n")
      : `- Центральный отель — уточните цены в ${currency}`;

  const b = plan.dailyBudget;
  const budget = `Еда: ${b.food || `~3000 ${currency}`}
Транспорт: ${b.transport || `~600 ${currency}`}
Билеты и входы: ${b.tickets || `~1500 ${currency}`}
Покупки: ${b.shopping || `~1200 ${currency}`}
Жильё: ${b.lodging || `~8000 ${currency}`}
ИТОГО за день: ${b.total || `~14300 ${currency}`}`;

  const tips =
    plan.tips && plan.tips.length
      ? plan.tips.map((t) => `${(t.category || "СОВЕТ").toUpperCase()}. ${t.text}`).join("\n")
      : "ТРАНСПОРТ. Берите дневной проездной — такси внутри центра редко окупается.";

  return `Маршрут по ${plan.destination}${plan.country ? `, ${plan.country}` : ""}. Тема: ${plan.theme || "город"}.

${dayBlocks.join("\n\n")}

ОТЕЛИ
${hotels}

БЮДЖЕТ НА ДЕНЬ
${budget}

ЛАЙФХАКИ ОТ БЫВАЛЫХ
${tips}`;
}
