-- Stores real OAuth-connected Meta (Facebook/Instagram) accounts per client.
-- Unlike app_state, this table is NOT anon-readable: page_access_token is a
-- real credential, so RLS is enabled with no anon/authenticated policies at
-- all. Only the service_role key (used inside Edge Functions) can read or
-- write it. The frontend gets connection status via social_accounts_public.

create table social_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  page_id text not null,
  ig_user_id text,
  page_name text not null,
  page_access_token text not null,
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform)
);

alter table social_accounts enable row level security;
-- No policies created: anon/authenticated have zero access by default.
-- service_role bypasses RLS entirely, which is how Edge Functions use it.

-- Safe subset the frontend (anon key) is allowed to read, to show
-- "Connected as X" in the UI without ever exposing page_access_token.
create view social_accounts_public as
  select client_id, platform, page_name, connected_at
  from social_accounts;

alter view social_accounts_public set (security_invoker = false);
grant select on social_accounts_public to anon;
