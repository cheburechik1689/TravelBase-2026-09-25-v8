-- TravelBase product schema: cabinets, JSONB itineraries, offers, purchases.
-- JSONB keeps trip page structure flexible without schema migrations.

create table if not exists profiles (
  user_id     text primary key,
  display_name text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists offers (
  id          text primary key,
  title       text not null,
  subtitle    text not null default '',
  description text not null default '',
  price_rub   integer not null,
  period      text not null,
  features    jsonb not null default '[]'::jsonb,
  sort_order  integer not null default 0,
  active      boolean not null default true
);

create table if not exists subscriptions (
  user_id     text primary key,
  status      text not null default 'free',
  offer_id    text,
  started_at  timestamptz,
  expires_at  timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists purchases (
  id                  text primary key,
  user_id             text not null,
  offer_id            text not null,
  amount_rub          integer not null,
  status              text not null default 'pending',
  gateway             text not null default 'payselection',
  gateway_payment_id  text,
  payer_email         text,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index if not exists purchases_user_id_idx on purchases (user_id);
create index if not exists purchases_status_idx on purchases (status);

create table if not exists trips (
  id               text primary key,
  user_id          text not null,
  destination      text not null,
  destination_key  text not null,
  title            text,
  days_count       integer not null default 1,
  visible_days     integer not null default 2,
  plan_json        jsonb not null default '{}'::jsonb,
  plan_text        text not null default '',
  coords           jsonb,
  request          jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists trips_user_id_idx on trips (user_id);
create index if not exists trips_dest_idx on trips (user_id, destination_key);

-- First two free days are frozen per user + destination (rule 10).
create table if not exists destination_cache (
  user_id          text not null,
  destination_key  text not null,
  destination      text not null,
  free_days_json   jsonb not null,
  plan_text        text not null default '',
  coords           jsonb,
  created_at       timestamptz not null default now(),
  primary key (user_id, destination_key)
);

create table if not exists shared_trips (
  id           text primary key,
  user_id      text,
  destination  text not null,
  plan_text    text not null,
  plan_json    jsonb,
  days_count   integer,
  budget       text,
  travelers    text,
  coords       jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists feedback (
  id           text primary key,
  user_id      text,
  rating       integer,
  text         text,
  contact      text,
  destination  text,
  created_at   timestamptz not null default now()
);

insert into offers (id, title, subtitle, description, price_rub, period, features, sort_order)
values
  (
    'plus-month',
    'TravelBase Plus',
    'месяц',
    'Полные маршруты без лимита в 2 дня. Карты, бюджет, лайфхаки и кабинет.',
    349,
    'month',
    '["Все дни маршрута, не только 2 бесплатных","Сохранение поездок в кабинете","Повторная генерация без кэша бесплатных дней","Приоритетная сборка маршрутов"]'::jsonb,
    1
  ),
  (
    'plus-year',
    'TravelBase Plus',
    'год',
    'Годовая подписка со скидкой. Выгоднее месяца почти вдвое.',
    2490,
    'year',
    '["Все дни маршрута на 12 месяцев","Сохранение поездок в кабинете","Повторная генерация без кэша бесплатных дней","Приоритетная сборка маршрутов","−40% к месячной цене"]'::jsonb,
    2
  )
on conflict (id) do nothing;
