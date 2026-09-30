import type { PlanJson } from "./plan-schema";

const DISTRICTS = [
  "Исторический центр",
  "Набережная и старый порт",
  "Богемный район",
  "Парки и холмы",
  "Современный центр",
  "Рынки и гастрономия",
  "Смотровые и закат",
];

export function fallbackPlanJson(opts: {
  destination: string;
  days: number;
  theme: string;
  currency: string;
  budget: string;
  wishes: string;
}): PlanJson {
  const city = opts.destination;
  const days = Array.from({ length: opts.days }, (_, i) => {
    const d = i + 1;
    const district = DISTRICTS[(d - 1) % DISTRICTS.length];
    const wishHint = opts.wishes ? ` Учитываем пожелание: ${opts.wishes.slice(0, 80)}.` : "";
    return {
      day: d,
      district,
      places: [
        {
          name: `Главная площадь ${city}`,
          address: district,
          timeStart: "09:00",
          timeEnd: "10:30",
          durationMin: 90,
          walkMinFromPrev: 0,
          description: `Сердце района, откуда удобно строить пеший день.${wishHint}`,
          price: "бесплатно",
        },
        {
          name: "Городской музей или собор",
          address: `рядом с ${district}`,
          timeStart: "10:45",
          timeEnd: "12:30",
          durationMin: 105,
          walkMinFromPrev: 8,
          description: "Короткий переход и спокойный осмотр. Лучше взять аудиогид и не гнаться за всеми залами.",
          price: `~1200 ${opts.currency}`,
        },
        {
          name: "Местное кафе на обед",
          address: district,
          timeStart: "12:45",
          timeEnd: "14:00",
          durationMin: 75,
          walkMinFromPrev: 6,
          description: "Обедаем там, где сидят местные. Попросите блюдо дня.",
          price: `~1800 ${opts.currency}`,
        },
        {
          name: "Рынок или ремесленные улицы",
          address: district,
          timeStart: "14:15",
          timeEnd: "16:00",
          durationMin: 105,
          walkMinFromPrev: 10,
          description: `Живой квартал под тему «${opts.theme}». Удобно совместить с сувенирами.`,
          price: "свободно / сувениры по желанию",
        },
        {
          name: "Смотровая или набережная",
          address: district,
          timeStart: "16:20",
          timeEnd: "18:00",
          durationMin: 100,
          walkMinFromPrev: 12,
          description: "К вечеру район раскрывается. Не спешите — поймайте золотой час.",
          price: `бесплатно или ~500 ${opts.currency}`,
        },
        {
          name: "Ужин в районе",
          address: district,
          timeStart: "19:00",
          timeEnd: "21:00",
          durationMin: 120,
          walkMinFromPrev: 10,
          description: "Заведение в том же кластере, без долгих переездов.",
          price: `~3500 ${opts.currency}`,
        },
      ],
    };
  });

  return {
    destination: city,
    country: "",
    theme: opts.theme,
    days,
    hotels: [
      {
        name: "Центральный бутик-отель",
        area: "10 мин пешком до дня 1",
        pricePerNight: `~9000 ${opts.currency}/ночь`,
        note: "Тихо и удобно как база.",
      },
      {
        name: "Семейные апартаменты",
        area: "набережная",
        pricePerNight: `~7000 ${opts.currency}/ночь`,
        note: "Кухня и стиралка.",
      },
      {
        name: "Дизайн-отель",
        area: "богемный район",
        pricePerNight: `~11000 ${opts.currency}/ночь`,
        note: "Если важна атмосфера.",
      },
    ],
    dailyBudget: {
      food: `~5300 ${opts.currency}`,
      transport: `~600 ${opts.currency}`,
      tickets: `~1700 ${opts.currency}`,
      shopping: `~1500 ${opts.currency}`,
      lodging: `~9000 ${opts.currency}`,
      total: `~18100 ${opts.currency}`,
    },
    tips: [
      { category: "ТРАНСПОРТ", text: "Сразу купите городской проездной — такси внутри центра почти не окупается." },
      { category: "ДЕНЬГИ", text: "Не меняйте валюту в аэропорту: курс хуже на 5–12%." },
      { category: "ВРЕМЯ", text: "К главным точкам приходите к открытию. Онлайн-билет экономит 40–90 минут." },
      { category: "ЕДА", text: "Если меню на 6 языках и хостес с буклетом — туристическая ловушка." },
    ],
  };
}
