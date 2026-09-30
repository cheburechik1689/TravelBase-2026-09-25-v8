-- Telegram identity + favorites bound to the same user_id as trips/subscriptions.

alter table profiles add column if not exists telegram_id text;
create unique index if not exists profiles_telegram_id_idx on profiles (telegram_id) where telegram_id is not null;

create table if not exists favorites (
  id          text primary key,
  user_id     text not null,
  kind        text not null,
  item_key    text not null,
  title       text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, kind, item_key)
);
create index if not exists favorites_user_id_idx on favorites (user_id);
