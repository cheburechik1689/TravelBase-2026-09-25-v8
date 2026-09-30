import { getSql } from "@/lib/db";
import { asJson, newId } from "./json";
import type { PlanJson } from "./plan-schema";
import { emptyPlan } from "./plan-schema";
import { pagesFromPlan, withPageIds, type TripPage } from "./pages";

export type OfferRow = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  price_rub: number;
  period: string;
  features: string[];
};

export type SubscriptionState = {
  status: "free" | "active" | "expired";
  offerId: string | null;
  expiresAt: string | null;
  subscribed: boolean;
};

export type TripRow = {
  id: string;
  destination: string;
  destinationKey: string;
  title: string | null;
  daysCount: number;
  visibleDays: number;
  planJson: PlanJson;
  planText: string;
  coords: { lat: number; lon: number } | null;
  createdAt: string;
  theme: string;
  preview: string[];
};

export type PurchaseRow = {
  id: string;
  offerId: string;
  amountRub: number;
  status: string;
  gateway: string;
  createdAt: string;
  paidAt: string | null;
};

export async function upsertProfile(userId: string, email?: string | null, name?: string | null) {
  const sql = await getSql();
  await sql.query(
    `insert into profiles (user_id, email, display_name)
     values ($1, $2, $3)
     on conflict (user_id) do update set
       email = coalesce(excluded.email, profiles.email),
       display_name = coalesce(excluded.display_name, profiles.display_name),
       updated_at = now()`,
    [userId, email || null, name || null],
  );
}

export async function upsertTelegramProfile(userId: string, telegramId: string, name?: string | null) {
  const sql = await getSql();
  await sql.query(
    `insert into profiles (user_id, display_name, telegram_id)
     values ($1, $2, $3)
     on conflict (user_id) do update set
       display_name = coalesce(excluded.display_name, profiles.display_name),
       telegram_id = coalesce(excluded.telegram_id, profiles.telegram_id),
       updated_at = now()`,
    [userId, name || null, telegramId],
  );
}

export async function listOffers(): Promise<OfferRow[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    title: string;
    subtitle: string;
    description: string;
    price_rub: number;
    period: string;
    features: unknown;
  }>(`select id, title, subtitle, description, price_rub, period, features from offers where active = true order by sort_order asc`);
  return rows.map((r) => ({
    ...r,
    features: asJson<string[]>(r.features, []),
  }));
}

export async function getOffer(id: string) {
  const sql = await getSql();
  const rows = await sql.query<OfferRow & { features: unknown }>(
    `select id, title, subtitle, description, price_rub, period, features from offers where id = $1 and active = true`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, features: asJson<string[]>(row.features, []) };
}

export async function getSubscription(userId: string): Promise<SubscriptionState> {
  const sql = await getSql();
  const rows = await sql.query<{
    status: string;
    offer_id: string | null;
    expires_at: string | Date | null;
  }>(`select status, offer_id, expires_at from subscriptions where user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return { status: "free", offerId: null, expiresAt: null, subscribed: false };
  const expiresAt = row.expires_at ? String(row.expires_at) : null;
  const stillActive =
    row.status === "active" && (!expiresAt || new Date(expiresAt).getTime() > Date.now());
  return {
    status: stillActive ? "active" : expiresAt ? "expired" : "free",
    offerId: row.offer_id,
    expiresAt,
    subscribed: stillActive,
  };
}

export async function activateSubscription(userId: string, offerId: string, period: string) {
  const sql = await getSql();
  const days = period === "year" ? 365 : 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  await sql.query(
    `insert into subscriptions (user_id, status, offer_id, started_at, expires_at, updated_at)
     values ($1, 'active', $2, now(), $3, now())
     on conflict (user_id) do update set
       status = 'active',
       offer_id = excluded.offer_id,
       started_at = now(),
       expires_at = excluded.expires_at,
       updated_at = now()`,
    [userId, offerId, expires],
  );
  return expires;
}

export async function createPurchase(input: {
  userId: string;
  offerId: string;
  amountRub: number;
  email?: string;
}) {
  const sql = await getSql();
  const id = newId("pay");
  await sql.query(
    `insert into purchases (id, user_id, offer_id, amount_rub, status, gateway, payer_email)
     values ($1, $2, $3, $4, 'pending', 'payselection', $5)`,
    [id, input.userId, input.offerId, input.amountRub, input.email || null],
  );
  return id;
}

export async function getPurchase(id: string, userId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    user_id: string;
    offer_id: string;
    amount_rub: number;
    status: string;
    gateway: string;
  }>(`select id, user_id, offer_id, amount_rub, status, gateway from purchases where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);
  return rows[0] || null;
}

export async function markPurchasePaid(id: string, userId: string) {
  const sql = await getSql();
  await sql.query(
    `update purchases set status = 'paid', paid_at = now(), gateway_payment_id = $3
     where id = $1 and user_id = $2 and status = 'pending'`,
    [id, userId, `ps_${id}`],
  );
}

export async function listPurchases(userId: string): Promise<PurchaseRow[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    offer_id: string;
    amount_rub: number;
    status: string;
    gateway: string;
    created_at: string;
    paid_at: string | null;
  }>(
    `select id, offer_id, amount_rub, status, gateway, created_at, paid_at
     from purchases where user_id = $1 order by created_at desc limit 30`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    offerId: r.offer_id,
    amountRub: r.amount_rub,
    status: r.status,
    gateway: r.gateway,
    createdAt: String(r.created_at),
    paidAt: r.paid_at ? String(r.paid_at) : null,
  }));
}

export async function getDestinationCache(userId: string, key: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    destination: string;
    free_days_json: unknown;
    plan_text: string;
    coords: unknown;
  }>(
    `select destination, free_days_json, plan_text, coords from destination_cache
     where user_id = $1 and destination_key = $2`,
    [userId, key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    destination: row.destination,
    plan: asJson<PlanJson>(row.free_days_json, emptyPlan(row.destination)),
    planText: row.plan_text,
    coords: asJson<{ lat: number; lon: number } | null>(row.coords, null),
  };
}

export async function saveDestinationCache(input: {
  userId: string;
  key: string;
  destination: string;
  plan: PlanJson;
  planText: string;
  coords: { lat: number; lon: number } | null;
}) {
  const sql = await getSql();
  await sql.query(
    `insert into destination_cache (user_id, destination_key, destination, free_days_json, plan_text, coords)
     values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
     on conflict (user_id, destination_key) do nothing`,
    [
      input.userId,
      input.key,
      input.destination,
      JSON.stringify(input.plan),
      input.planText,
      input.coords ? JSON.stringify(input.coords) : null,
    ],
  );
}

export async function saveTrip(input: {
  userId: string;
  destination: string;
  key: string;
  daysCount: number;
  visibleDays: number;
  plan: PlanJson;
  planText: string;
  coords: { lat: number; lon: number } | null;
  request: Record<string, unknown>;
}) {
  const sql = await getSql();
  const id = newId("trip");
  await sql.query(
    `insert into trips
      (id, user_id, destination, destination_key, title, days_count, visible_days, plan_json, plan_text, coords, request)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb)`,
    [
      id,
      input.userId,
      input.destination,
      input.key,
      `Поездка в ${input.destination}`,
      input.daysCount,
      input.visibleDays,
      JSON.stringify(input.plan),
      input.planText,
      input.coords ? JSON.stringify(input.coords) : null,
      JSON.stringify(input.request),
    ],
  );
  await insertPages(id, input.userId, input.plan);
  return id;
}

async function insertPages(tripId: string, userId: string, plan: PlanJson) {
  const sql = await getSql();
  const pages = withPageIds(pagesFromPlan(plan));
  for (const page of pages) {
    await sql.query(
      `insert into trip_pages (id, trip_id, user_id, kind, sort_order, title, body)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [page.id, tripId, userId, page.kind, page.sortOrder, page.title, JSON.stringify(page.body)],
    );
  }
  return pages;
}

export async function listPages(tripId: string, userId: string): Promise<TripPage[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    kind: TripPage["kind"];
    sort_order: number;
    title: string;
    body: unknown;
  }>(
    `select id, kind, sort_order, title, body from trip_pages
     where trip_id = $1 and user_id = $2 order by sort_order asc`,
    [tripId, userId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    sortOrder: r.sort_order,
    title: r.title,
    body: asJson(r.body, {}),
  }));
}

export async function getTrip(userId: string, tripId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    destination: string;
    destination_key: string;
    title: string | null;
    days_count: number;
    visible_days: number;
    plan_json: unknown;
    plan_text: string;
    coords: unknown;
    created_at: string;
  }>(
    `select id, destination, destination_key, title, days_count, visible_days, plan_json, plan_text, coords, created_at
     from trips where id = $1 and user_id = $2`,
    [tripId, userId],
  );
  const r = rows[0];
  if (!r) return null;
  const pages = await listPages(tripId, userId);
  return {
    id: r.id,
    destination: r.destination,
    destinationKey: r.destination_key,
    title: r.title,
    daysCount: r.days_count,
    visibleDays: r.visible_days,
    planJson: asJson<PlanJson>(r.plan_json, emptyPlan(r.destination)),
    planText: r.plan_text,
    coords: asJson<{ lat: number; lon: number } | null>(r.coords, null),
    createdAt: String(r.created_at),
    pages,
  };
}

export async function patchPage(input: {
  pageId: string;
  tripId: string;
  userId: string;
  body: Record<string, unknown>;
  title?: string;
}) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `update trip_pages
        set body = $4::jsonb,
            title = coalesce($5, title),
            updated_at = now()
      where id = $1 and trip_id = $2 and user_id = $3
      returning id`,
    [input.pageId, input.tripId, input.userId, JSON.stringify(input.body ?? {}), input.title || null],
  );
  return Boolean(rows[0]);
}

export async function replaceTripPlan(input: {
  tripId: string;
  userId: string;
  plan: PlanJson;
  planText: string;
}) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `update trips set plan_json = $3::jsonb, plan_text = $4, updated_at = now()
     where id = $1 and user_id = $2 returning id`,
    [input.tripId, input.userId, JSON.stringify(input.plan), input.planText],
  );
  if (!rows[0]) return false;
  await sql.query(`delete from trip_pages where trip_id = $1 and user_id = $2`, [input.tripId, input.userId]);
  await insertPages(input.tripId, input.userId, input.plan);
  return true;
}

export async function listTrips(userId: string): Promise<TripRow[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    destination: string;
    destination_key: string;
    title: string | null;
    days_count: number;
    visible_days: number;
    plan_json: unknown;
    plan_text: string;
    coords: unknown;
    created_at: string;
  }>(
    `select id, destination, destination_key, title, days_count, visible_days, plan_json, plan_text, coords, created_at
     from trips where user_id = $1 order by created_at desc limit 40`,
    [userId],
  );
  return rows.map((r) => {
    const plan = asJson<PlanJson>(r.plan_json, emptyPlan(r.destination));
    return {
      id: r.id,
      destination: r.destination,
      destinationKey: r.destination_key,
      title: r.title,
      daysCount: r.days_count,
      visibleDays: r.visible_days,
      planJson: plan,
      planText: r.plan_text,
      coords: asJson<{ lat: number; lon: number } | null>(r.coords, null),
      createdAt: String(r.created_at),
      theme: plan.theme || "",
      preview: (plan.days[0]?.places || []).slice(0, 3).map((p) => p.name),
    };
  });
}

export async function deleteTrip(userId: string, tripId: string) {
  const sql = await getSql();
  await sql.query(`delete from trip_pages where trip_id = $1 and user_id = $2`, [tripId, userId]);
  const rows = await sql.query<{ id: string }>(`delete from trips where id = $1 and user_id = $2 returning id`, [
    tripId,
    userId,
  ]);
  return Boolean(rows[0]);
}

export async function renameTrip(userId: string, tripId: string, title: string) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `update trips set title = $3, updated_at = now() where id = $1 and user_id = $2 returning id`,
    [tripId, userId, title.slice(0, 80)],
  );
  return Boolean(rows[0]);
}

export async function listDestinationCache(userId: string) {
  const sql = await getSql();
  return sql.query<{ destination: string; destination_key: string; created_at: string }>(
    `select destination, destination_key, created_at
       from destination_cache
      where user_id = $1
      order by created_at desc
      limit 20`,
    [userId],
  );
}

export async function saveSharedTrip(input: {
  userId?: string;
  destination: string;
  planText: string;
  planJson?: unknown;
  daysCount?: string | number;
  budget?: string;
  travelers?: string;
  coords?: unknown;
}) {
  const sql = await getSql();
  const id = newId("").slice(0, 8);
  await sql.query(
    `insert into shared_trips (id, user_id, destination, plan_text, plan_json, days_count, budget, travelers, coords)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb)`,
    [
      id,
      input.userId || null,
      input.destination,
      input.planText,
      input.planJson ? JSON.stringify(input.planJson) : null,
      input.daysCount ? Number(input.daysCount) : null,
      input.budget || null,
      input.travelers || null,
      input.coords ? JSON.stringify(input.coords) : null,
    ],
  );
  return id;
}

export async function getSharedTrip(id: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    destination: string;
    plan_text: string;
    days_count: number | null;
    budget: string | null;
    travelers: string | null;
    coords: unknown;
    created_at: string;
  }>(
    `select destination, plan_text, days_count, budget, travelers, coords, created_at
     from shared_trips where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    destination: row.destination,
    plan: row.plan_text,
    daysCount: row.days_count,
    budget: row.budget,
    travelers: row.travelers,
    coords: asJson(row.coords, null),
    created: String(row.created_at),
  };
}

export async function addFeedbackRow(input: {
  userId?: string;
  rating?: unknown;
  text: string;
  contact: string;
  destination: string;
}) {
  const sql = await getSql();
  await sql.query(
    `insert into feedback (id, user_id, rating, text, contact, destination)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      newId("fb"),
      input.userId || null,
      typeof input.rating === "number" ? input.rating : null,
      input.text,
      input.contact,
      input.destination,
    ],
  );
}

export type FavoriteRow = {
  id: string;
  kind: string;
  itemKey: string;
  title: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export async function listFavorites(userId: string): Promise<FavoriteRow[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    kind: string;
    item_key: string;
    title: string;
    payload: unknown;
    created_at: string;
  }>(
    `select id, kind, item_key, title, payload, created_at from favorites
     where user_id = $1 order by created_at desc limit 80`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    itemKey: r.item_key,
    title: r.title,
    payload: asJson<Record<string, unknown>>(r.payload, {}),
    createdAt: String(r.created_at),
  }));
}

export async function toggleFavorite(input: {
  userId: string;
  kind: string;
  itemKey: string;
  title: string;
  payload: Record<string, unknown>;
}): Promise<{ saved: boolean; item: FavoriteRow | null }> {
  const sql = await getSql();
  const existing = await sql.query<{ id: string }>(
    `select id from favorites where user_id = $1 and kind = $2 and item_key = $3`,
    [input.userId, input.kind, input.itemKey],
  );
  if (existing[0]) {
    await sql.query(`delete from favorites where id = $1 and user_id = $2`, [existing[0].id, input.userId]);
    return { saved: false, item: null };
  }
  const id = newId("fav");
  await sql.query(
    `insert into favorites (id, user_id, kind, item_key, title, payload)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [id, input.userId, input.kind, input.itemKey, input.title, JSON.stringify(input.payload || {})],
  );
  return {
    saved: true,
    item: {
      id,
      kind: input.kind,
      itemKey: input.itemKey,
      title: input.title,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    },
  };
}
