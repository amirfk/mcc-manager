-- Audit trail for every APPLIED change made by the mcc-manager `manage` function.
-- Run this once in the Supabase SQL editor (or via the CLI) before going live.
--
-- Security model: RLS is ON with NO policies, so anon/authenticated clients get
-- nothing. Only the service-role key (used server-side by the Netlify function,
-- which bypasses RLS) can read or write. Never expose the service-role key to a
-- browser.

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  action      text        not null,          -- e.g. set_campaign_status, update_campaign_budget
  customer_id text        not null,          -- the sub-account acted on
  target      text,                          -- human label, e.g. "campaign 123 (Brand)"
  field       text,                          -- what changed, e.g. "status" / "daily budget"
  old_value   text,                          -- value before the change
  new_value   text,                          -- value after the change
  request     jsonb,                         -- the exact mutate operation sent
  result      jsonb,                         -- the API response
  status      text        not null default 'applied'
);

create index if not exists audit_log_ts_idx          on public.audit_log (ts desc);
create index if not exists audit_log_customer_id_idx on public.audit_log (customer_id);

alter table public.audit_log enable row level security;
-- Intentionally no policies: service-role only.
