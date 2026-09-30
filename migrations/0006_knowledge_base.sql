-- Knowledge base: русскоязычные источники → сырой корпус документов.
-- Наполняется офлайн-краулером scripts/crawl-sources.mjs (не из request-цикла).

create table if not exists sources (
  id              text primary key,
  url             text unique,
  kind            text,
  trust           smallint default 5,
  last_crawled_at timestamptz,
  active          boolean default true
);

insert into sources (id, url, kind, trust) values
  ('wikivoyage-ru', 'https://ru.wikivoyage.org', 'guide', 9),
  ('tourister',     'https://tourister.ru', 'diaries', 7),
  ('tonkosti',      'https://tonkosti.ru', 'guide', 7),
  ('34travel',      'https://34travel.me', 'guide', 7),
  ('vandrouki',     'https://vandrouki.ru', 'blog', 6),
  ('vokrugsveta',   'https://www.vokrugsveta.ru', 'magazine', 6),
  ('nat-geo',       'https://nat-geo.ru', 'magazine', 6),
  ('openarium',     'https://openarium.ru', 'diaries', 6),
  ('autotravel',    'https://autotravel.ru', 'diaries', 6),
  ('kuda-go',       'https://kuda-go.com', 'aggregator', 5)
on conflict (id) do nothing;

create table if not exists raw_documents (
  id              text primary key,
  source_id       text references sources(id),
  url             text unique,
  title           text,
  lang            text,
  destination_key text,
  content         text,
  fetched_at      timestamptz default now(),
  hash            text
);
create index if not exists raw_documents_destination_key_idx on raw_documents (destination_key);

create table if not exists kb_places (
  id              text primary key,
  destination_key text,
  name            text,
  kind            text,
  lat             double precision,
  lon             double precision,
  description     text,
  price_hint      text,
  season_hint     text,
  score           real default 0,
  raw_ids         jsonb default '[]'::jsonb
);
create index if not exists kb_places_destination_score_idx on kb_places (destination_key, score desc);

create table if not exists kb_routes (
  id              text primary key,
  destination_key text,
  title           text,
  days            jsonb,
  raw_id          text references raw_documents(id)
);

create table if not exists kb_facts (
  id              text primary key,
  destination_key text,
  category        text,
  text            text,
  confidence      real default 0.5
);
