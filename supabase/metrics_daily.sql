-- Daily performance time-series. One row per (date, level, entity). Upserted on
-- each snapshot so re-pulling a day refreshes it (Google revises recent days as
-- conversions attribute late) rather than duplicating. Run once in Supabase.

create table if not exists public.metrics_daily (
  id            bigint generated always as identity primary key,
  report_date   date        not null,
  level         text        not null,        -- campaign | ad_group | keyword | ad
  entity_id     text        not null,        -- campaign/ad group/criterion/ad id
  entity_name   text,
  campaign_id   text,
  campaign_name text,
  cost          numeric     not null default 0,
  impressions   bigint      not null default 0,
  clicks        bigint      not null default 0,
  conversions   numeric     not null default 0,
  conv_value    numeric     not null default 0,
  pulled_at     timestamptz not null default now(),
  unique (report_date, level, entity_id)
);

create index if not exists metrics_daily_date_idx   on public.metrics_daily (report_date desc);
create index if not exists metrics_daily_entity_idx on public.metrics_daily (level, entity_id);

alter table public.metrics_daily enable row level security;
-- Service-role only (server-side functions). No public policies.
