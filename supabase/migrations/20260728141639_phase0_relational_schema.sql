-- Phase 0 of the auth + relational data model redesign (see
-- .claude/plans/modular-herding-castle.md for full context). Additive only:
-- nothing here touches app_state or the live frontend yet.

create table public.clients (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per Supabase Auth user, covers admin/editor/client uniformly.
-- Client usernames map to synthetic emails (lower(username)+'@livali-internal.invalid')
-- computed by the frontend/Edge Functions -- never a real inbox.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'client')),
  client_id text references public.clients(id) on delete cascade,
  username text not null,
  email text not null unique,
  created_at timestamptz not null default now(),
  constraint client_role_requires_client_id check (
    (role = 'client' and client_id is not null) or (role <> 'client' and client_id is null)
  )
);
create unique index profiles_username_lower_idx on public.profiles (lower(username));

create table public.posts (
  id text primary key,
  client_id text not null references public.clients(id) on delete cascade,
  platforms text[] not null default '{}',
  post_date date not null,
  post_time time not null,
  title text not null,
  caption text not null default '',
  media_data_url text,
  media_type text check (media_type in ('image', 'video')),
  media_name text,
  media_expired boolean not null default false,
  pillar text not null default '',
  assignee text not null default '',
  statuses text[] not null default '{}',
  client_note text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posts_client_id_idx on public.posts (client_id);
create index posts_date_idx on public.posts (post_date);

-- strategyKey in the old JSON blob was `${clientId}-${period}`; split into
-- (client_id, period_key) so it's a real composite key instead of a string hack.
create table public.strategy_notes (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients(id) on delete cascade,
  period_key text not null,
  note text not null default '',
  updated_at timestamptz not null default now(),
  unique (client_id, period_key)
);

alter table public.social_accounts
  add constraint social_accounts_client_id_fkey foreign key (client_id) references public.clients(id) on delete cascade;

-- RLS: nothing granted to anon at all here, unlike app_state's mistake.
alter table public.clients enable row level security;
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.strategy_notes enable row level security;

grant select on public.clients, public.profiles, public.posts, public.strategy_notes to authenticated;
grant insert, update, delete on public.posts to authenticated;

create policy clients_select on public.clients for select to authenticated
  using ( (auth.jwt() ->> 'user_role') in ('admin', 'editor')
          or id = (auth.jwt() ->> 'client_id') );

create policy profiles_select on public.profiles for select to authenticated
  using ( id = auth.uid() or (auth.jwt() ->> 'user_role') = 'admin' );

create policy posts_select on public.posts for select to authenticated
  using ( (auth.jwt() ->> 'user_role') in ('admin', 'editor')
          or client_id = (auth.jwt() ->> 'client_id') );
create policy posts_insert on public.posts for insert to authenticated
  with check ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') );
create policy posts_update on public.posts for update to authenticated
  using ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') )
  with check ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') );
create policy posts_delete on public.posts for delete to authenticated
  using ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') );

-- Admin/editor only, full stop -- clients never had a Strategy tab
-- (the frontend's view() getter already redirects them away from it).
create policy strategy_notes_all on public.strategy_notes for all to authenticated
  using ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') )
  with check ( (auth.jwt() ->> 'user_role') in ('admin', 'editor') );

-- Client-scoped mutations go through these two RPCs rather than a raw UPDATE
-- grant, since RLS can't restrict which *columns* a role touches on a row --
-- a client should only ever flip statuses/leave a note, never touch
-- caption/media/schedule. Mirrors the same transitionStatuses() semantics
-- the frontend already uses for approvePost/submitChangeRequest.
create or replace function public.approve_post(p_post_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'user_role') <> 'client' then
    raise exception 'not authorized';
  end if;
  update public.posts
  set statuses = array_append(
        array_remove(array_remove(statuses, 'needs-approval'), 'changes-requested'),
        'scheduled'
      ),
      updated_at = now()
  where id = p_post_id and client_id = (auth.jwt() ->> 'client_id');
  if not found then
    raise exception 'post not found or not permitted';
  end if;
end;
$$;
revoke all on function public.approve_post(text) from public;
grant execute on function public.approve_post(text) to authenticated;

create or replace function public.submit_change_request(p_post_id text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'user_role') <> 'client' then
    raise exception 'not authorized';
  end if;
  update public.posts
  set statuses = array_append(array_remove(statuses, 'needs-approval'), 'changes-requested'),
      client_note = p_note,
      updated_at = now()
  where id = p_post_id and client_id = (auth.jwt() ->> 'client_id');
  if not found then
    raise exception 'post not found or not permitted';
  end if;
end;
$$;
revoke all on function public.submit_change_request(text, text) from public;
grant execute on function public.submit_change_request(text, text) to authenticated;

-- Custom Access Token Auth Hook: injects role/client_id into the JWT from
-- profiles, so RLS policies read auth.jwt() directly with no per-request
-- join. Deliberately named "user_role", NOT "role" -- PostgREST reads the
-- JWT's own "role" claim to SET ROLE on the Postgres connection, so
-- overwriting it with 'admin'/'editor'/'client' would break API access
-- entirely for every signed-in user, not just RLS.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := event -> 'claims';
  prof record;
begin
  select role, client_id into prof from public.profiles where id = (event ->> 'user_id')::uuid;
  if prof is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(prof.role));
    claims := jsonb_set(claims, '{client_id}', to_jsonb(prof.client_id));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
