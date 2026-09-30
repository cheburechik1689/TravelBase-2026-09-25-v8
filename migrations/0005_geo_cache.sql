-- Server-side cache for expensive external geo lookups (Nominatim / Overpass / Photon).
-- Read through src/lib/travelbase/geo-cache.ts with a 7-day TTL.

create table if not exists geo_cache (
  cache_key   text primary key,
  kind        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists geo_cache_kind_idx on geo_cache (kind);
