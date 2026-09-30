import { z } from "zod";

/** Ответ Kimi на экстракцию знаний из одного сырого документа (raw_documents). */

export const KbPlaceSchema = z.object({
  name: z.string().min(2).max(160),
  kind: z.string().max(40).optional().default("attraction"),
  description: z.string().max(2000).optional().default(""),
  price_hint: z.string().max(120).optional().default(""),
  season_hint: z.string().max(120).optional().default(""),
});

export const KbFactSchema = z.object({
  category: z.string().max(60).optional().default("general"),
  text: z.string().min(10).max(2000),
});

/** Маршрут: days — массив дней, каждый день — массив названий мест. */
export const KbRouteSchema = z.object({
  title: z.string().min(3).max(200),
  days: z.array(z.array(z.string().max(160))).min(1).max(14),
});

export const KbExtractionSchema = z.object({
  places: z.array(KbPlaceSchema).max(60).optional().default([]),
  facts: z.array(KbFactSchema).max(40).optional().default([]),
  routes: z.array(KbRouteSchema).max(10).optional().default([]),
});

export type KbPlace = z.infer<typeof KbPlaceSchema>;
export type KbExtraction = z.infer<typeof KbExtractionSchema>;

/** safeParse + fallback на пустую экстракцию: битый ответ модели не роняет прогон. */
export function parseExtraction(raw: unknown): KbExtraction {
  const parsed = KbExtractionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { places: [], facts: [], routes: [] };
}
