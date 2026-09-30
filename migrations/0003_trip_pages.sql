-- Each itinerary screen is its own JSONB document so days/hotels/tips
-- can be edited independently without rewriting the whole trip.

create table if not exists trip_pages (
  id          text primary key,
  trip_id     text not null,
  user_id     text not null,
  kind        text not null,
  sort_order  integer not null default 0,
  title       text not null default '',
  body        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists trip_pages_trip_idx on trip_pages (trip_id, sort_order);
create index if not exists trip_pages_user_idx on trip_pages (user_id);
