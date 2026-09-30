import { z } from "zod";

export const PlaceSchema = z.object({
  name: z.string().min(2).max(140),
  address: z.string().max(220).optional().default(""),
  timeStart: z.string().max(8).optional().default("09:00"),
  timeEnd: z.string().max(8).optional().default("10:30"),
  durationMin: z.coerce.number().int().min(15).max(360).optional().default(90),
  walkMinFromPrev: z.coerce.number().int().min(0).max(90).optional().default(8),
  description: z.string().max(500).optional().default(""),
  price: z.string().max(120).optional().default("бесплатно"),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  kind: z.string().max(40).optional(),
});

export const DaySchema = z.object({
  day: z.coerce.number().int().min(1).max(14),
  district: z.string().max(100).optional().default("Центр"),
  places: z.array(PlaceSchema).min(1).max(8),
});

export const HotelSchema = z.object({
  name: z.string().min(2).max(140),
  area: z.string().max(120).optional().default(""),
  pricePerNight: z.string().max(80).optional().default(""),
  note: z.string().max(240).optional().default(""),
});

export const TipSchema = z.object({
  category: z.string().max(40).optional().default("СОВЕТ"),
  text: z.string().min(4).max(400),
});

export const DailyBudgetSchema = z.object({
  food: z.string().max(80).optional().default(""),
  transport: z.string().max(80).optional().default(""),
  tickets: z.string().max(80).optional().default(""),
  shopping: z.string().max(80).optional().default(""),
  lodging: z.string().max(80).optional().default(""),
  total: z.string().max(80).optional().default(""),
});

export const PlanSchema = z.object({
  destination: z.string().min(2).max(120),
  country: z.string().max(80).optional().default(""),
  theme: z.string().max(160).optional().default(""),
  days: z.array(DaySchema).min(1).max(14),
  hotels: z.array(HotelSchema).max(5).optional().default([]),
  dailyBudget: DailyBudgetSchema.optional().default({
    food: "",
    transport: "",
    tickets: "",
    shopping: "",
    lodging: "",
    total: "",
  }),
  tips: z.array(TipSchema).max(8).optional().default([]),
});

export type Place = z.infer<typeof PlaceSchema>;
export type PlanDay = z.infer<typeof DaySchema>;
export type PlanJson = z.infer<typeof PlanSchema>;

export type AccessInfo = {
  subscribed: boolean;
  freeDays: number;
  requestedDays: number;
  visibleDays: number;
  cached: boolean;
  requiresAuthForCache: boolean;
};

export function emptyPlan(destination = ""): PlanJson {
  return {
    destination,
    country: "",
    theme: "",
    days: [],
    hotels: [],
    dailyBudget: { food: "", transport: "", tickets: "", shopping: "", lodging: "", total: "" },
    tips: [],
  };
}

export function parsePlanJson(raw: unknown): PlanJson | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = PlanSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clipPlanDays(plan: PlanJson, maxDays: number): PlanJson {
  const n = Math.max(1, Math.min(maxDays, plan.days.length));
  return { ...plan, days: plan.days.slice(0, n).map((d, i) => ({ ...d, day: i + 1 })) };
}
