import {
  currencyRates,
  detectGeoIp,
  hotelLinks,
  lookupIata,
  PRESET_POPULAR,
  PRESET_RUSSIA,
} from "./catalog";
import { knowledgeSuggest, generatePlan, swapPlace } from "./generate";
import { matchDestinations } from "./match";
import { catalogForCity } from "./search";
import {
  geocodePlace,
  getWeather,
  nearbyPois,
  optimizeOrder,
  osrmRoute,
  reverseGeocode,
  wikipediaPhoto,
  wikipediaPlaceInfo,
  haversineM,
} from "./geo";
import { json, num, readJson, str } from "./http";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "./rate-limit";
import { parsePlanJson } from "./plan-schema";
import { isUnauthorized, optionalUser, requireUser } from "./session";
import { GOLD_ROUTES } from "./gold-routes";
import {
  activateSubscription,
  addFeedbackRow,
  createPurchase,
  getOffer,
  getPurchase,
  getSharedTrip,
  getSubscription,
  getTrip,
  listFavorites,
  listOffers,
  listPurchases,
  listTrips,
  markPurchasePaid,
  patchPage,
  replaceTripPlan,
  renameTrip,
  deleteTrip,
  listDestinationCache,
  saveSharedTrip,
  toggleFavorite,
  upsertProfile,
} from "./store";
import { dbSource, getSql } from "@/lib/db";

function luhnOk(numStr: string) {
  const digits = numStr.replace(/\s+/g, "");
  if (!/^\d{16,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export async function handleTravelApi(request: Request, splat: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = splat.replace(/\/+$/, "");

  try {
    if (method === "GET" && path === "health") {
      return json({
        status: "ok",
        ai: Boolean(process.env.MOONSHOT_API_KEY),
        db: dbSource,
        search: "overpass+photon",
        freeDays: 2,
      });
    }
    if (method === "GET" && path === "kb-stats") {
      try {
        const sql = await getSql();
        const places = await sql<{ n: number }>`select count(*) as n from kb_places`;
        const docs = await sql<{ n: number }>`select count(*) as n from raw_documents`;
        return json({
          success: true,
          kbPlaces: Number(places[0]?.n ?? 0),
          rawDocuments: Number(docs[0]?.n ?? 0),
        });
      } catch (err) {
        console.warn("[api] kb-stats failed:", err);
        return json({ success: true, kbPlaces: 0, rawDocuments: 0 });
      }
    }
    if (method === "GET" && path === "currency-rates") {
      return json(await currencyRates());
    }
    if (method === "GET" && path === "popular-destinations") {
      const url = new URL(request.url);
      const region = url.searchParams.get("region");
      return json({ destinations: region === "russia" ? PRESET_RUSSIA : PRESET_POPULAR });
    }
    if (method === "GET" && path === "geoip") {
      return json(await detectGeoIp(request));
    }
    if (method === "GET" && path === "offers") {
      return json({ success: true, offers: await listOffers(), freeDays: 2 });
    }
    if (method === "GET" && path === "gold-routes") {
      const url = new URL(request.url);
      const region = url.searchParams.get("region");
      const list = GOLD_ROUTES.filter((r) => !region || r.region === region).map((r) => ({
        id: r.id,
        title: r.title,
        city: r.city,
        country: r.country,
        days: r.days,
        region: r.region,
        tags: r.tags,
        img: r.img,
      }));
      return json({ success: true, routes: list });
    }
    if (method === "GET" && path === "me") {
      const user = await optionalUser(request);
      if (!user) {
        return json({ success: true, user: null, subscription: { subscribed: false, status: "free" } });
      }
      const sub = await getSubscription(user.id);
      return json({
        success: true,
        user: { id: user.id, email: user.email },
        subscription: sub,
        freeDays: 2,
      });
    }
    if (method === "GET" && path === "me/trips") {
      const user = await requireUser(request);
      if (isUnauthorized(user)) return user;
      return json({ success: true, trips: await listTrips(user.id) });
    }
    if (method === "GET" && path === "me/purchases") {
      const user = await requireUser(request);
      if (isUnauthorized(user)) return user;
      return json({ success: true, purchases: await listPurchases(user.id) });
    }
    if (method === "GET" && path === "me/cache") {
      const user = await requireUser(request);
      if (isUnauthorized(user)) return user;
      const rows = await listDestinationCache(user.id);
      return json({
        success: true,
        cache: rows.map((r) => ({
          destination: r.destination,
          key: r.destination_key,
          createdAt: String(r.created_at),
        })),
      });
    }
    if (method === "GET" && path === "catalog") {
      const url = new URL(request.url);
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const city = str(url.searchParams.get("city"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json({ success: false, error: "lat/lon required" }, 400);
      }
      const pois = await catalogForCity({ city: city || "city", lat, lon });
      return json({ success: true, pois });
    }
    if (method === "GET" && path === "me/favorites") {
      const user = await requireUser(request);
      if (isUnauthorized(user)) return user;
      return json({ success: true, favorites: await listFavorites(user.id) });
    }
    if (method === "GET" && path.startsWith("shared/")) {
      const id = path.slice("shared/".length);
      const trip = await getSharedTrip(id);
      if (!trip) return json({ success: false, error: "not found" }, 404);
      return json({ success: true, ...trip });
    }

    if (method === "GET" && path.startsWith("trips/")) {
      const user = await requireUser(request);
      if (isUnauthorized(user)) return user;
      const id = path.slice("trips/".length);
      const trip = await getTrip(user.id, id);
      if (!trip) return json({ success: false, error: "not found" }, 404);
      return json({
        success: true,
        ...trip,
        plan: trip.planText,
        access: {
          subscribed: (await getSubscription(user.id)).subscribed,
          freeDays: 2,
          requestedDays: trip.daysCount,
          visibleDays: trip.visibleDays,
          cached: false,
        },
      });
    }

    if (method !== "POST") {
      return json({ success: false, error: "not found" }, 404);
    }

    const body = await readJson(request);

    switch (path) {
      case "generate": {
        const user = await optionalUser(request);
        const limited = checkRateLimit("generate", rateLimitKey(request, user?.id));
        if (!limited.ok) return rateLimitResponse(limited.retryAfterSec);
        const result = await generatePlan(body, user);
        if (!result.ok) {
          return json(
            { success: false, error: result.error, message: result.error },
            result.status,
          );
        }
        return json({
          success: true,
          plan: result.plan,
          planJson: result.planJson,
          coords: result.coords,
          access: result.access,
          tripId: result.tripId,
          pages: result.pages,
          source: result.source,
          kbHits: result.kbHits ?? 0,
        });
      }
      case "favorites/toggle": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const kind = str(body.kind, "city").slice(0, 24);
        const itemKey = str(body.key || body.itemKey).slice(0, 160);
        const title = str(body.title).slice(0, 160);
        if (!itemKey) return json({ success: false, error: "key required" }, 400);
        const payload =
          body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : {};
        const result = await toggleFavorite({
          userId: user.id,
          kind,
          itemKey,
          title: title || itemKey,
          payload,
        });
        return json({ success: true, ...result });
      }
      case "knowledge-suggest": {
        const suggestUser = await optionalUser(request);
        const limited = checkRateLimit("knowledge-suggest", rateLimitKey(request, suggestUser?.id));
        if (!limited.ok) return rateLimitResponse(limited.retryAfterSec);
        const result = await knowledgeSuggest(str(body.prompt), str(body.region));
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        const { ok: _ok, ...rest } = result;
        return json({ success: true, ...rest });
      }
      case "match-destinations": {
        const matchUser = await optionalUser(request);
        const limited = checkRateLimit("match-destinations", rateLimitKey(request, matchUser?.id));
        if (!limited.ok) return rateLimitResponse(limited.retryAfterSec);
        const result = await matchDestinations(body);
        return json({
          success: true,
          results: result.results,
          source: result.source,
          candidatesCount: result.candidatesCount,
        });
      }
      case "geocode": {
        const place = str(body.place);
        const geo = await geocodePlace({
          place,
          destination: str(body.destination),
          destLat: num(body.destLat),
          destLon: num(body.destLon),
        });
        if (!geo) return json({ success: false, error: `Place "${place}" not found` });
        return json({
          success: true,
          place,
          lat: geo.lat,
          lon: geo.lon,
          address: geo.address,
        });
      }
      case "reverse-geocode": {
        const lat = num(body.lat);
        const lon = num(body.lon);
        if (lat == null || lon == null) {
          return json({ success: false, error: "lat/lon required" }, 400);
        }
        const geo = await reverseGeocode(lat, lon);
        if (!geo) return json({ success: false, error: "not found" }, 404);
        return json({
          success: true,
          name: geo.name,
          address: geo.address,
          lat: geo.lat,
          lon: geo.lon,
        });
      }
      case "route":
      case "route_multi": {
        const points = Array.isArray(body.points) ? body.points : [];
        const pts = points
          .map((p) => {
            const rec = p as Record<string, unknown>;
            const lat = num(rec.lat);
            const lon = num(rec.lon);
            return lat != null && lon != null ? { lat, lon } : null;
          })
          .filter((p): p is { lat: number; lon: number } => Boolean(p));
        if (pts.length < 2) {
          return json({ success: false, error: "At least 2 points required" }, 400);
        }
        const route = await osrmRoute(pts, str(body.profile, "foot"));
        if (!route) return json({ success: false, error: "Route not found" }, 404);
        return json({ success: true, ...route });
      }
      case "optimize-day": {
        const places = Array.isArray(body.places) ? body.places : [];
        const valid = places
          .map((p) => p as Record<string, unknown>)
          .filter((p) => num(p.lat) != null && num(p.lon) != null)
          .map((p) => ({
            name: str(p.name, "Точка"),
            lat: num(p.lat) as number,
            lon: num(p.lon) as number,
          }));
        const optimized = optimizeOrder(valid);
        const segments = [];
        let total = 0;
        for (let i = 0; i < optimized.length - 1; i++) {
          const a = optimized[i];
          const b = optimized[i + 1];
          const d = haversineM(a.lat, a.lon, b.lat, b.lon);
          total += d;
          segments.push({
            from: str(a.name, `Point ${i + 1}`),
            to: str(b.name, `Point ${i + 2}`),
            distanceM: Math.round(d),
            walkMinutes: Math.max(1, Math.round(d / 80)),
          });
        }
        return json({
          success: true,
          places: optimized,
          totalDistanceM: Math.round(total),
          segments,
        });
      }
      case "weather": {
        const lat = num(body.lat);
        const lon = num(body.lon);
        if (lat == null || lon == null) {
          return json({ success: false, error: "lat/lon required" }, 400);
        }
        const weather = await getWeather({
          lat,
          lon,
          dateStart: str(body.dateStart) || undefined,
          dateEnd: str(body.dateEnd) || undefined,
        });
        return json({ success: true, days: weather.days, type: weather.type });
      }
      case "photo": {
        const url = await wikipediaPhoto(str(body.place), str(body.destination));
        if (!url) return json({ success: false, error: "photo not found" });
        return json({ success: true, url, source: "wikipedia" });
      }
      case "place-details": {
        return json({ success: false, error: "Place details not found" }, 404);
      }
      case "place-info": {
        const info = await wikipediaPlaceInfo(str(body.place), str(body.destination));
        if (!info) return json({ success: false, error: "place info not found" }, 404);
        return json({ success: true, ...info });
      }
      case "nearby-pois": {
        const bbox = Array.isArray(body.bbox) ? body.bbox.map((x) => Number(x)) : [];
        if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
          return json({ success: false, error: "bbox [s,w,n,e] required" }, 400);
        }
        const pois = await nearbyPois(bbox, Number(body.limit) || 80);
        return json({ success: true, pois, cached: false });
      }
      case "iata": {
        const result = await lookupIata(str(body.city));
        if (!result) return json({ success: false, error: "City IATA not found" }, 404);
        return json({ success: true, ...result });
      }
      case "flights": {
        return json({ success: true, flights: [], currency: str(body.currency, "rub") });
      }
      case "hotels": {
        return json(hotelLinks(body));
      }
      case "feedback": {
        const user = await optionalUser(request);
        const text = str(body.text).trim();
        const rating = body.rating;
        if (!text && rating == null) {
          return json({ success: false, error: "Нужен текст или оценка" }, 400);
        }
        await addFeedbackRow({
          userId: user?.id,
          rating,
          text: text.slice(0, 2000),
          contact: str(body.contact).slice(0, 200),
          destination: str(body.destination).slice(0, 120),
        });
        return json({ success: true });
      }
      case "share": {
        const user = await optionalUser(request);
        const shareId = await saveSharedTrip({
          userId: user?.id,
          destination: str(body.destination),
          planText: str(body.plan),
          planJson: body.planJson,
          daysCount: body.daysCount as string | number | undefined,
          budget: str(body.budget),
          travelers: str(body.travelers),
          coords: body.coords,
        });
        return json({ success: true, shareId });
      }
      case "swap-place": {
        const result = await swapPlace(body);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({
          success: true,
          newPlace: result.newPlace,
          description: result.description,
          lat: "lat" in result ? result.lat : undefined,
          lon: "lon" in result ? result.lon : undefined,
          kind: "kind" in result ? result.kind : undefined,
        });
      }
      case "trips/page": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const rawBody = body.body;
        const pageBody =
          rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
            ? (rawBody as Record<string, unknown>)
            : {};
        const ok = await patchPage({
          userId: user.id,
          tripId: str(body.tripId),
          pageId: str(body.pageId),
          body: pageBody,
          title: str(body.title) || undefined,
        });
        if (!ok) return json({ success: false, error: "Страница не найдена" }, 404);
        return json({ success: true });
      }
      case "trips/replace-plan": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const parsed = parsePlanJson(body.planJson);
        if (!parsed) {
          return json({ success: false, error: "Некорректный план" }, 400);
        }
        const ok = await replaceTripPlan({
          userId: user.id,
          tripId: str(body.tripId),
          plan: parsed,
          planText: str(body.planText),
        });
        if (!ok) return json({ success: false, error: "Поездка не найдена" }, 404);
        return json({ success: true });
      }
      case "trips/delete": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const ok = await deleteTrip(user.id, str(body.tripId));
        if (!ok) return json({ success: false, error: "Поездка не найдена" }, 404);
        return json({ success: true });
      }
      case "trips/rename": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const title = str(body.title).trim();
        if (title.length < 2) return json({ success: false, error: "Слишком короткое название" }, 400);
        const ok = await renameTrip(user.id, str(body.tripId), title);
        if (!ok) return json({ success: false, error: "Поездка не найдена" }, 404);
        return json({ success: true });
      }
      case "billing/checkout": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const offer = await getOffer(str(body.offerId, "plus-month"));
        if (!offer) return json({ success: false, error: "Тариф не найден" }, 404);
        await upsertProfile(user.id, user.email);
        const purchaseId = await createPurchase({
          userId: user.id,
          offerId: offer.id,
          amountRub: Number(offer.price_rub),
          email: user.email || str(body.email),
        });
        return json({
          success: true,
          purchaseId,
          offer,
          gateway: "payselection",
          amountRub: offer.price_rub,
        });
      }
      case "billing/complete": {
        const user = await requireUser(request);
        if (isUnauthorized(user)) return user;
        const purchaseId = str(body.purchaseId);
        const purchase = await getPurchase(purchaseId, user.id);
        if (!purchase) return json({ success: false, error: "Платёж не найден" }, 404);
        if (purchase.status === "paid") {
          const sub = await getSubscription(user.id);
          return json({ success: true, alreadyPaid: true, subscription: sub });
        }
        const card = str(body.cardNumber).replace(/\s+/g, "");
        const exp = str(body.expiry);
        const cvc = str(body.cvc);
        if (!luhnOk(card)) {
          return json({ success: false, error: "Проверьте номер карты" }, 400);
        }
        if (!/^\d{2}\/\d{2}$/.test(exp)) {
          return json({ success: false, error: "Срок: ММ/ГГ" }, 400);
        }
        const [mm, yy] = exp.split("/").map(Number);
        const expDate = new Date(2000 + yy, mm);
        if (mm < 1 || mm > 12 || expDate.getTime() < Date.now()) {
          return json({ success: false, error: "Карта просрочена" }, 400);
        }
        if (!/^\d{3,4}$/.test(cvc)) {
          return json({ success: false, error: "Проверьте CVC" }, 400);
        }
        const offer = await getOffer(purchase.offer_id);
        if (!offer) return json({ success: false, error: "Тариф не найден" }, 404);
        await markPurchasePaid(purchase.id, user.id);
        const expiresAt = await activateSubscription(user.id, offer.id, offer.period);
        return json({
          success: true,
          subscription: { subscribed: true, status: "active", offerId: offer.id, expiresAt },
        });
      }
      case "cluster-trip":
      case "itinerary":
      case "my-trips": {
        const user = await optionalUser(request);
        if (!user) return json({ success: true, trips: [], days: [], clusters: [] });
        const trips = await listTrips(user.id);
        return json({ success: true, trips, days: [], clusters: [] });
      }
      default:
        return json({ success: false, error: "not found" }, 404);
    }
  } catch (err) {
    console.error("TravelBase API", path, err);
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
